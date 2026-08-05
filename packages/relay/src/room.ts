/**
 * Room — membership, transcript, presence, and the bridge between connected
 * editors and whichever driver is running the agent.
 *
 * Deliberately holds no Anthropic types: it talks to a driver interface, so the
 * future BYO driver drops in without touching this file.
 */

import { randomUUID } from "node:crypto";
import type {
  ActionEntry,
  AgentActivity,
  AttachedAgent,
  ConnectionRole,
  Member,
  RoomStatus,
  RoomMode,
  RosterEntry,
  ServerMsg,
  ToolProgressState,
  TranscriptEntry,
} from "@mpa/protocol";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import { toRosterEntry } from "./roomCore.js";
import type { RoomDriver } from "./driver.js";
import type { AgentUsage, RoomRole, TurnUsage } from "@mpa/protocol";
import type { RoomSnapshot } from "./roomStore.js";

/**
 * The slice of a WebSocket the room actually uses. Depending on this rather
 * than the `ws` class keeps the fan-out testable without opening sockets.
 */
export interface SocketLike {
  readonly readyState: number;
  readonly OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

interface Connection {
  member: Member;
  socket: SocketLike;
}

/** One of a member's own agents. Several may share an owner. */
interface AgentConnection extends Connection {
  id: string;
  label: string;
  /** Last reported activity. Absent until its host says — see AgentActivity. */
  state?: AgentActivity;
}

/** Identifies an agent connection; humans are identified by handle alone. */
export interface AgentIdentity {
  id: string;
  label: string;
}

export class Room {
  private readonly connections = new Map<string, Connection>();
  /**
   * Each member's own agents, keyed by agent id rather than by handle — one
   * person may run several at once (a coder and a reviewer, say), and they must
   * not evict each other or their owner's editor connection.
   */
  private readonly agents = new Map<string, AgentConnection>();
  /** Everyone who has ever joined, so the roster keeps offline members visible. */
  private readonly known = new Map<string, Member>();
  private readonly transcript: TranscriptEntry[] = [];
  /**
   * How much a room keeps in memory.
   *
   * Only the *persisted* copy was capped, so a room that never empties grew
   * without limit: after 5,000 messages a joiner was sent every one of them in
   * a single frame, and it kept getting bigger. The same numbers as the store,
   * so what a joiner sees matches what a restart brings back.
   */
  private static readonly MAX_TRANSCRIPT = 500;
  /**
   * Longest single message.
   *
   * Long enough for an agent to paste a file or a stack trace, short enough that
   * 500 of them cannot exhaust a room. The frame cap in the server is the outer
   * bound; this is the one that keeps a *room* sane.
   */
  private static readonly MAX_MESSAGE_CHARS = 32_000;
  private static readonly MAX_ACTIONS = 200;
  /** Agent entries already flushed, so a late delta cannot resurrect one. */
  private readonly completed = new Set<string>();
  private status: RoomStatus = "idle";
  private waitingOn?: string;
  /**
   * The member offering their machine as the room's shared workspace.
   *
   * Agents cannot share a filesystem by configuration — a local CLI acts where
   * it runs — so "the room's workspace" means one member's machine, and other
   * members' agents reach it by routing tool calls here.
   */
  private host?: string;
  /**
   * Handles *currently connected* as the room's shared workspace.
   *
   * Only ever consulted for claim precedence, which is a question about who is
   * here now. Whether something *is* a workspace is answered by its handle —
   * see isContainer — because that handle is reserved and survives the socket
   * dropping. Deriving it from this set meant that the moment the container
   * reconnected, or the relay restarted, the roster lost `kind` and the agent's
   * system prompt described `@workspace` as an offline *person* it should stop
   * addressing tools to.
   */
  private readonly containers = new Set<string>();
  /**
   * What each member may do.
   *
   * The first person in an empty room owns it — there is nobody else to ask, and
   * a room whose owner must be granted by an owner can never start. Everyone
   * after that is a member until the owner says otherwise.
   */
  private readonly roles = new Map<string, RoomRole>();
  /**
   * What each agent has spent, keyed by agent id.
   *
   * Kept per agent rather than per member because "which of my agents is
   * expensive" is the question people actually have, and a member running a
   * coder and a reviewer cannot answer it from one number.
   */
  private readonly usage = new Map<string, AgentUsage>();
  /** What agents have done, distinct from what people have said. */
  private readonly actions: ActionEntry[] = [];
  /** Outstanding remote tool requests, so a reply can find who asked. */
  private readonly remoteCalls = new Map<
    string,
    {
      agentId: string;
      /** The id the *asking* agent chose. Only ever echoed back to it. */
      clientRequestId: string;
      targetHandle: string;
      name: string;
      input: Record<string, unknown>;
    }
  >();
  /**
   * Ids are minted here, never taken from the client.
   *
   * Every client counts from zero on its own — `fs_0`, `rt_1`, `w_0` — so two
   * members' agents routinely pick the same id. Keying outstanding calls on that
   * meant one agent's file was delivered to the other and recorded against the
   * wrong agent. Agent ids are namespaced by owner for the same reason; this was
   * simply missed.
   */
  private nextRemoteCall = 0;

  constructor(
    readonly code: string,
    private readonly driver: RoomDriver,
    /** Surfaced to clients so a room can never lie about which driver it runs. */
    readonly mode: RoomMode = "byo"
  ) {}

  /**
   * Restore a room from disk.
   *
   * Everyone is absent until they reconnect — a snapshot says who has been here,
   * never who is here now, and restoring presence would have the agent
   * addressing tools to machines that are not connected.
   */
  hydrate(snapshot: RoomSnapshot): void {
    for (const member of snapshot.members) {
      if (!this.known.has(member.handle)) this.known.set(member.handle, member);
    }
    for (const [handle, role] of Object.entries(snapshot.roles ?? {})) {
      this.roles.set(handle, role);
    }
    for (const entry of snapshot.usage ?? []) this.usage.set(entry.agentId, entry);
    this.transcript.push(...snapshot.transcript.slice(-Room.MAX_TRANSCRIPT));
    this.actions.push(...snapshot.actions.slice(-Room.MAX_ACTIONS));
    // Agent messages restored from disk are already final; without this a
    // late delta could resurrect one that finished before the restart.
    for (const entry of snapshot.transcript) {
      if (entry.kind === "agent") this.completed.add(entry.id);
    }
  }

  snapshot(): RoomSnapshot {
    return {
      transcript: this.transcript,
      actions: this.actions,
      members: [...this.known.values()],
      roles: Object.fromEntries(this.roles),
      usage: this.usageReport,
    };
  }

  /** Called whenever something worth keeping changed. */
  onChanged?: () => void;

  get roster(): RosterEntry[] {
    return [...this.known.values()].map((m) =>
      toRosterEntry(
        m,
        this.connections.has(m.handle),
        this.agentsOf(m.handle),
        isContainer(m.handle) ? "workspace" : undefined,
        isContainer(m.handle) ? undefined : this.roleOf(m.handle)
      )
    );
  }

  get usageReport(): AgentUsage[] {
    return [...this.usage.values()];
  }

  /**
   * Record what an agent's turn cost.
   *
   * Providers report different things — Claude Code gives dollars and tokens, an
   * OpenAI-compatible endpoint gives tokens and leaves pricing to whoever pays,
   * a wrapped CLI gives nothing. Absent stays absent: a zero here would read as
   * "this agent was free", which is a confident claim about the one thing we
   * were not told.
   */
  recordUsage(agentId: string, provider: string, turn: TurnUsage): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const running = this.usage.get(agentId) ?? {
      agentId,
      agentLabel: agent.label,
      owner: agent.member.handle,
      provider,
      turns: 0,
    };
    running.agentLabel = agent.label;
    running.turns += 1;
    running.costUsd = add(running.costUsd, turn.costUsd);
    running.inputTokens = add(running.inputTokens, turn.inputTokens);
    running.outputTokens = add(running.outputTokens, turn.outputTokens);
    running.cacheReadTokens = add(running.cacheReadTokens, turn.cacheReadTokens);
    // Reported once ⇒ reported. A provider that answers intermittently should
    // not be described as silent because of one empty turn. The flag is deleted
    // rather than set false, so "we were told nothing" is an absence in the data
    // as well as in the meaning.
    if (
      running.costUsd === undefined &&
      running.inputTokens === undefined &&
      running.outputTokens === undefined
    ) {
      running.unreported = true;
    } else {
      delete running.unreported;
    }

    this.usage.set(agentId, running);
    this.broadcast({ t: "usage", agents: this.usageReport });
    this.onChanged?.();
  }

  /** Everyone is a member until told otherwise; the container holds no role. */
  roleOf(handle: string): RoomRole {
    return this.roles.get(handle) ?? "member";
  }

  /** May they speak, attach agents and act on the workspace? */
  canAct(handle: string): boolean {
    return this.roleOf(handle) !== "viewer";
  }

  /**
   * Change what somebody may do.
   *
   * Only the owner, and never on themselves: a room whose owner demotes
   * themselves by accident has nobody who can undo it.
   */
  setRole(actor: string, handle: string, role: RoomRole): void {
    if (this.roleOf(actor) !== "owner") {
      this.systemTo(actor, "Only the room's owner can change what someone may do.");
      return;
    }
    if (actor === handle) {
      this.systemTo(actor, "You cannot change your own role; the room would have no owner.");
      return;
    }
    if (isContainer(handle)) {
      this.systemTo(actor, "The shared workspace is not a person and holds no role.");
      return;
    }
    this.roles.set(handle, role);
    this.system(`${this.known.get(handle)?.displayName ?? handle} is now a ${role}.`);
    this.broadcastRoster();
    this.onChanged?.();
  }

  private agentsOf(handle: string): AttachedAgent[] {
    return [...this.agents.values()]
      .filter((a) => a.member.handle === handle)
      .map((a) => ({ id: a.id, owner: handle, label: a.label, state: a.state }));
  }

  /**
   * An agent's host reporting what it is doing.
   *
   * Broadcast so the room can see it and so other agents are told: an agent
   * that knows another is still thinking can say so, instead of answering half
   * a question as though the other half were never asked. Unchanged states are
   * dropped — a busy room would otherwise broadcast a full roster twice a turn
   * per agent.
   */
  setAgentState(agentId: string, state: AgentActivity): void {
    const agent = this.agents.get(agentId);
    if (!agent || agent.state === state) return;
    agent.state = state;
    this.broadcastRoster();
  }

  /* ---------------------------------------------------------------- */
  /* Membership                                                        */
  /* ---------------------------------------------------------------- */

  async join(
    member: Member,
    socket: SocketLike,
    role: ConnectionRole = "human",
    agent?: AgentIdentity
  ): Promise<void> {
    // An agent attaches under its owner's handle but supplies its own idea of
    // their name. The human connection is the authority on who they are, so an
    // agent may only fill in an identity nobody has claimed yet.
    if (role === "human" || !this.known.has(member.handle)) {
      this.known.set(member.handle, member);
    }
    if (role === "workspace") {
      this.known.set(member.handle, member);
      this.containers.add(member.handle);
    } else if (this.roles.size === 0 && !isContainer(member.handle)) {
      // Somebody has to own it, and in an empty room there is nobody to ask.
      this.roles.set(member.handle, "owner");
    }

    let label: string;
    let myAgentId: string | undefined;
    if (role === "agent") {
      const id = (myAgentId = agent?.id ?? `${member.handle}:default`);
      label = agent?.label ?? `${member.displayName}'s agent`;
      // Replacing by *agent id* — not by handle — is what lets one person run
      // several agents at once without them evicting each other.
      this.agents.get(id)?.socket.close(4000, `another connection claimed the agent id ${id}`);
      this.agents.set(id, { member, socket, id, label });
    } else {
      label = member.displayName;
      this.connections.get(member.handle)?.socket.close(
        4000,
        `another session joined as @${member.handle}`
      );
      this.connections.set(member.handle, { member, socket });
    }

    this.sendTo(socket, {
      t: "joined",
      room: this.code,
      mode: this.mode,
      workspaceHost: this.host,
      actions: this.actions,
      usage: this.usageReport,
      you: toRosterEntry(
        member,
        true,
        this.agentsOf(member.handle),
        isContainer(member.handle) ? "workspace" : undefined,
        isContainer(member.handle) ? undefined : this.roleOf(member.handle)
      ),
      // The relay mints the agent id — it namespaces it by owner so two clients
      // defaulting to the same one cannot evict each other — so the relay is
      // also the only thing that can say what it ended up as. Without this an
      // agent cannot recognise its own messages in the transcript, and an agent
      // that signs off with its own name would wake itself.
      youAgentId: myAgentId,
      roster: this.roster,
      transcript: this.transcript,
    });
    this.system(`${label} joined the room.`);
    this.broadcastRoster();
    await this.tellDriver();
  }

  /**
   * `socket` identifies *which* connection died. Without it a reconnect evicts
   * its own replacement: join() closes the stale socket and installs the new
   * one, then the stale socket's close event arrives and deletes the entry —
   * leaving the member connected, composing happily, and invisible to everyone.
   */
  async leave(
    handle: string,
    role: ConnectionRole = "human",
    socket?: SocketLike,
    agentId?: string
  ): Promise<void> {
    let label: string;
    if (role === "agent") {
      const key = agentId ?? `${handle}:default`;
      const conn = this.agents.get(key);
      if (!conn) return;
      if (socket && conn.socket !== socket) return;
      label = conn.label;
      this.agents.delete(key);
    } else {
      const conn = this.connections.get(handle);
      if (!conn) return;
      if (socket && conn.socket !== socket) return;
      label = isContainer(handle) ? "The shared workspace" : conn.member.displayName;
      this.connections.delete(handle);
      this.containers.delete(handle);
      // Anything dispatched to them will never be answered now. Say so at once
      // rather than leaving the asking agent to burn its full timeout on a
      // machine that has gone — and leaving the entry in the map forever.
      this.failRemoteCallsFor(handle);
      // A departed host leaves every room-pointed agent with nowhere to act, so
      // release the claim rather than leaving agents addressing a dead machine.
      if (this.host === handle) {
        this.host = undefined;
        this.system("The room's workspace host left; agents pointed at the room have nowhere to act.");
      }
    }
    this.system(`${label} left the room.`);
    this.broadcastRoster();
    // A shared agent must stop addressing tools to them, or the room stalls
    // waiting on a machine that is no longer there.
    await this.tellDriver();
  }

  /**
   * Tell the driver who is in the room, without letting it break membership.
   *
   * In hosted mode this is a live API call that can 429 or 404. It used to be
   * awaited as the last statement of join() and leave(), so a throw propagated
   * out: the caller never recorded the connection, the close handler became a
   * no-op, and the member was reported present forever — in a room that could
   * then never be reaped, with the agent addressing tools to a socket that would
   * never answer. Failing to tell the agent about a roster change is a
   * degradation; losing track of who is connected is a corruption.
   */
  private async tellDriver(): Promise<void> {
    try {
      await this.driver.sendRoster(this.roster);
    } catch (err) {
      this.system(
        `The agent could not be told who is in the room (${err instanceof Error ? err.message : String(err)}). It may address the wrong person until this recovers.`
      );
    }
  }

  get workspaceHost(): string | undefined {
    return this.host;
  }

  /**
   * Claim or release the room's shared workspace.
   *
   * Only a present human may hold it: an agent cannot offer a machine, and an
   * absent member's workspace is unreachable, which would strand every agent
   * pointed at the room.
   */
  claimWorkspace(handle: string, claim: boolean): void {
    if (claim) {
      if (!this.connections.has(handle)) return;
      if (!this.canAct(handle)) {
        this.systemTo(handle, "Viewers cannot host the room's workspace.");
        return;
      }
      // A container outranks a laptop: it is the host that survives everyone
      // closing their editor, which is the whole reason it exists. A member
      // trying to claim over it is told why rather than silently ignored.
      if (this.host && this.host !== handle) {
        if (!isContainer(handle)) {
          if (isContainer(this.host)) {
            this.system(
              `@${handle} cannot host: this room's workspace is a shared container, which stays hosted when everyone disconnects.`
            );
          }
          return;
        }
        // Falls through: the container takes the claim from a member.
      }
      this.host = handle;
      this.system(`${this.known.get(handle)?.displayName ?? handle} is hosting the room's workspace.`);
    } else if (this.host === handle) {
      this.host = undefined;
      this.system("The room no longer has a shared workspace.");
    }
    this.broadcastRoster();
  }

  /**
   * Route an agent's request to act on another member's workspace.
   *
   * Resolving "room" to the host here rather than at the agent means an agent
   * never needs to know who is hosting, and the answer stays correct when the
   * host changes mid-session.
   */
  routeRemoteTool(
    requester: { agentId: string; label: string; handle: string },
    requestId: string,
    targetHandle: string,
    name: string,
    input: Record<string, unknown>
  ): void {
    const target = targetHandle === "room" ? this.host : targetHandle;
    if (!target) {
      this.replyRemote(requester.agentId, requestId, "This room has no shared workspace host.", true);
      return;
    }
    const conn = this.connections.get(target);
    if (!conn) {
      this.replyRemote(
        requester.agentId,
        requestId,
        `@${target} is not present, so their workspace cannot be reached.`,
        true
      );
      return;
    }

    // The executor only ever echoes the id it is handed, so the relay can use
    // its own and keep the agent's purely for the reply. No client changes.
    const callId = `rc_${this.nextRemoteCall++}`;
    this.remoteCalls.set(callId, {
      agentId: requester.agentId,
      clientRequestId: requestId,
      targetHandle: target,
      name,
      input,
    });
    this.sendTo(conn.socket, {
      t: "remoteToolRequest",
      requestId: callId,
      requesterAgentId: requester.agentId,
      requesterLabel: requester.label,
      requesterHandle: requester.handle,
      name,
      input,
    });
  }

  /**
   * The executing member answering; routed back to the agent that asked, and
   * recorded so every other agent can see the work without redoing it.
   */
  completeRemoteTool(handle: string, callId: string, content: string, isError: boolean): void {
    const pending = this.remoteCalls.get(callId);
    if (!pending) return;
    // Only the member the call was dispatched to may answer it. Without this,
    // any member could answer any call — forging the contents of somebody
    // else's workspace into an agent's context, and silently discarding the
    // real answer. `toolResult` below has always enforced the equivalent.
    if (pending.targetHandle !== handle) return;
    this.remoteCalls.delete(callId);
    this.replyRemote(pending.agentId, pending.clientRequestId, content, isError);

    const agent = this.agents.get(pending.agentId);
    if (agent && !isNavigation(pending.name)) {
      this.recordAction({
        agentId: pending.agentId,
        agentLabel: agent.label,
        targetHandle: pending.targetHandle,
        verb: verbFor(pending.name),
        target: describeToolTarget(pending.name, pending.input),
        detail: summariseResult(content, isError),
        ok: !isError,
      });
    }
  }

  /**
   * Tell one member something, rather than the whole room.
   *
   * A refusal is between the relay and whoever asked; broadcasting "you cannot
   * do that" to everyone would make ordinary mistakes into public ones.
   */
  private systemTo(handle: string, text: string): void {
    const conn = this.connections.get(handle);
    if (!conn) return;
    this.sendTo(conn.socket, {
      t: "entry",
      entry: {
        id: randomUUID(),
        kind: "system",
        authorHandle: "system",
        authorName: "Room",
        text,
        ts: Date.now(),
      },
    });
  }

  /** Fail every outstanding call aimed at a member who is no longer here. */
  private failRemoteCallsFor(handle: string): void {
    for (const [callId, pending] of this.remoteCalls) {
      if (pending.targetHandle !== handle) continue;
      this.remoteCalls.delete(callId);
      this.replyRemote(
        pending.agentId,
        pending.clientRequestId,
        `@${handle} disconnected before ${pending.name} could finish, so it was not completed.`,
        true
      );
    }
  }

  private replyRemote(agentId: string, requestId: string, content: string, isError: boolean): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    this.sendTo(agent.socket, { t: "remoteToolReply", requestId, content, isError });
  }

  /**
   * The host's files changed — tell everyone else so their caches drop.
   *
   * Only the host may say this: it is a statement about their disk, and nobody
   * else is in a position to make it.
   */
  noteWorkspaceChanged(handle: string, paths: string[]): void {
    if (this.host !== handle || paths.length === 0) return;
    this.broadcast({ t: "workspaceInvalidated", paths });
  }

  /** Record work, attributed to the acting agent rather than the host machine. */
  recordAction(entry: Omit<ActionEntry, "id" | "ts">): void {
    const full: ActionEntry = { ...entry, id: randomUUID(), ts: Date.now() };
    this.actions.push(full);
    if (this.actions.length > Room.MAX_ACTIONS) {
      this.actions.splice(0, this.actions.length - Room.MAX_ACTIONS);
    }
    this.broadcast({ t: "action", entry: full });
    this.onChanged?.();
  }

  get actionLog(): ActionEntry[] {
    return this.actions;
  }

  get isEmpty(): boolean {
    return this.connections.size === 0 && this.agents.size === 0;
  }

  /** Release the driver's session, stream and timers. */
  async dispose(): Promise<void> {
    await this.driver.close?.();
  }

  /* ---------------------------------------------------------------- */
  /* Inbound from members                                              */
  /* ---------------------------------------------------------------- */

  async say(
    handle: string,
    text: string,
    role: ConnectionRole = "human",
    agentId?: string
  ): Promise<void> {
    // Bounded before anything else touches it. The transcript lives in memory
    // and is rebroadcast to everyone, so an unbounded message is everyone's
    // problem rather than the sender's.
    text = text.slice(0, Room.MAX_MESSAGE_CHARS);
    if (role === "agent") {
      const conn = this.agents.get(agentId ?? `${handle}:default`);
      if (!conn || text.trim() === "") return;
      const depth = (this.chainDepth.get(conn.id) ?? 0) + 1;
      this.chainDepth.set(conn.id, depth);
      // Attributed to its owner, in their colour, and named so two of one
      // person's agents are told apart rather than blurring into "the agent".
      this.append({
        id: randomUUID(),
        kind: "agent",
        authorHandle: conn.member.handle,
        authorName: conn.label,
        agentId: conn.id,
        text,
        ts: Date.now(),
        hops: depth,
      });
      return;
    }

    const conn = this.connections.get(handle);
    if (!conn || text.trim() === "") return;
    // A person speaking restarts every chain. That is the whole shape of the
    // bound: agents may carry something a short way between two human messages,
    // and a human is what makes it a conversation again rather than a loop.
    this.chainDepth.clear();
    this.append({
      id: randomUUID(),
      kind: "human",
      authorHandle: conn.member.handle,
      authorName: conn.member.displayName,
      text,
      ts: Date.now(),
    });
    await this.driver.say(conn.member, text);
  }

  /**
   * How many times this agent has spoken since a person last did.
   *
   * The bound on agents talking to each other has to be something a client
   * cannot arrange to be lower, and the first version was not. It had the
   * client name the entry it was answering and derived the depth from that —
   * which stops a client *stating* a low number, but not choosing a shallow
   * parent. An agent deep in a chain could point at the original human message
   * and be handed depth 1 again, indefinitely. The test written for it asserted
   * exactly that and called it proof of the opposite.
   *
   * Counting per agent instead removes the client from it entirely: nothing in
   * the message influences the number. It also stops penalising wide rooms —
   * five agents answering one person are each on their first turn, where a
   * chain-position scheme would have made every one after the first look
   * deeper than it was.
   *
   * Counting rather than refusing is still deliberate: the bound is on which
   * agent *wakes*, not on what may be posted. Refusing to broadcast a message
   * an agent has already spent a turn producing would hide work that was done.
   */
  private readonly chainDepth = new Map<string, number>();

  /** Extend an outstanding call's deadline as its addressee makes progress. */
  toolProgress(handle: string, callId: string, state: ToolProgressState): void {
    this.driver.noteToolProgress?.(handle, callId, state);
  }

  /**
   * Only the member the call was addressed to may answer it.
   *
   * Authentication would not fix this on its own: an authenticated member could
   * still answer somebody else's call and forge the contents of their private
   * workspace into the shared context — which is precisely the provenance this
   * product sells.
   */
  async toolResult(
    handle: string,
    callId: string,
    content: string,
    isError: boolean
  ): Promise<void> {
    const owner = this.driver.ownerOfCall?.(callId);
    if (owner === undefined) {
      return; // No such outstanding call — nothing to answer.
    }
    if (owner !== handle) {
      return;
    }
    await this.driver.resolveToolCall(callId, content, isError);
  }

  /* ---------------------------------------------------------------- */
  /* Outbound from the driver                                          */
  /* ---------------------------------------------------------------- */

  onAgentDelta(entryId: string, text: string): void {
    if (this.completed.has(entryId)) return;
    this.broadcast({ t: "agentDelta", entryId, text });
  }

  /** Withdraw a preview that never became a message, so no client keeps it. */
  onAgentDeltaCancel(entryId: string): void {
    if (this.completed.has(entryId)) return;
    this.broadcast({ t: "agentDeltaCancel", entryId });
  }

  onAgentMessage(entryId: string, text: string): void {
    if (text.trim() === "") return;
    this.completed.add(entryId);
    this.append({
      id: entryId,
      kind: "agent",
      authorHandle: "agent",
      authorName: "Agent",
      text,
      ts: Date.now(),
    });
  }

  onToolCall(handle: string, callId: string, name: string, input: Record<string, unknown>): void {
    const conn = this.connections.get(handle);
    if (!conn) {
      // resolveTarget already rejects absent members; this is the race where
      // they disconnected in between. Fail fast rather than wait for the timeout.
      void this.driver.resolveToolCall(
        callId,
        `@${handle} disconnected before the tool could run.`,
        true
      );
      return;
    }
    this.sendTo(conn.socket, { t: "toolCall", callId, name, input });
  }

  onStatus(status: RoomStatus, waitingOn?: string): void {
    this.status = status;
    this.waitingOn = waitingOn;
    this.broadcast({ t: "status", status, waitingOn });
  }

  onError(message: string): void {
    this.system(`⚠ ${message}`);
    this.broadcast({ t: "error", message });
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  private system(text: string): void {
    this.append({
      id: randomUUID(),
      kind: "system",
      authorHandle: "system",
      authorName: "system",
      text,
      ts: Date.now(),
    });
  }

  private append(entry: TranscriptEntry): void {
    this.transcript.push(entry);
    if (this.transcript.length > Room.MAX_TRANSCRIPT) {
      this.transcript.splice(0, this.transcript.length - Room.MAX_TRANSCRIPT);
    }
    this.broadcast({ t: "entry", entry });
    this.onChanged?.();
  }

  private broadcastRoster(): void {
    this.broadcast({ t: "roster", roster: this.roster, workspaceHost: this.host });
    // Re-assert status so a joiner's UI is not stuck on a stale pill.
    this.broadcast({ t: "status", status: this.status, waitingOn: this.waitingOn });
  }

  /** Attached agents observe the room too — that is how they see what to answer. */
  private broadcast(msg: ServerMsg): void {
    for (const { socket } of this.connections.values()) this.sendTo(socket, msg);
    for (const { socket } of this.agents.values()) this.sendTo(socket, msg);
  }

  private sendTo(socket: SocketLike, msg: ServerMsg): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }
}

/* ------------------------------------------------------------------ */
/* Describing work                                                     */
/* ------------------------------------------------------------------ */

/**
 * A past-tense verb, so the log reads as a record of what happened rather than
 * a list of function names.
 */
/**
 * Browsing is not work.
 *
 * A filesystem view stats and lists constantly — expanding one folder is a
 * call, and every mouse click would become a row. The Work log exists to answer
 * "what did the agents change", and drowning that in navigation makes it
 * useless. Reads of file *contents* still count: an agent that read a file acted
 * on information from it.
 */
function isNavigation(tool: string): boolean {
  return tool === "list_dir" || tool === "stat" || tool === "list_files";
}

function verbFor(tool: string): string {
  switch (tool) {
    case "read_file":
      return "read";
    case "write_file":
      return "wrote";
    case "edit_file":
      return "edited";
    case "run_command":
      return "ran";
    case "search":
      return "searched";
    case "list_files":
    case "list_dir":
      return "listed";
    case "stat":
      return "checked";
    case "git_status":
      return "checked";
    case "diagnostics":
      return "checked";
    case "editor_context":
      return "looked at";
    default:
      return tool;
  }
}

/** The most identifying field, so a row says *what* was acted on. */
function describeToolTarget(tool: string, input: Record<string, unknown>): string {
  for (const key of ["path", "command", "query", "dir"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    }
  }
  if (tool === "git_status") return "git status";
  // "." is how a filesystem addresses the root, and it reads as nothing at all.
  const dir = input.path;
  if (dir === "." || dir === "" || dir === undefined) return "the workspace root";
  return "the workspace";
}

/**
 * A glanceable outcome. The full result already went to the agent; this is for
 * humans scanning the log and for other agents deciding whether to redo work.
 */
function summariseResult(content: string, isError: boolean): string {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (isError) {
    return firstLine.length > 60 ? `failed — ${firstLine.slice(0, 60)}…` : `failed — ${firstLine}`;
  }
  const lines = content.split("\n").length;
  return lines > 1 ? `${lines} lines` : firstLine.slice(0, 60);
}

/**
 * Is this handle the room's shared workspace?
 *
 * The handle is reserved by the relay and refused to everyone else, so it is a
 * reliable answer even when nothing is connected under it — which is exactly
 * when the question used to be got wrong.
 */
function isContainer(handle: string): boolean {
  return handle === WORKSPACE_HANDLE;
}

/**
 * Add two possibly-absent numbers, keeping absence.
 *
 * `undefined + 5` must be 5, but `undefined + undefined` must stay undefined —
 * otherwise a provider that never reports anything accumulates a confident zero.
 */
function add(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}
