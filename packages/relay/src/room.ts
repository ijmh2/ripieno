/**
 * Room — membership, transcript, presence, and the bridge between connected
 * editors and whichever driver is running the agent.
 *
 * Deliberately holds no Anthropic types: it talks to a driver interface, so the
 * future BYO driver drops in without touching this file.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type {
  ActionEntry,
  AgentActivity,
  AgentCapability,
  AgentPresence,
  AttachedAgent,
  ConnectionRole,
  ContextAuditEntry,
  ContextItem,
  ContextKind,
  ContextResultMsg,
  ContextStatus,
  Goal,
  GoalAuditEntry,
  GoalResultMsg,
  GoalTransition,
  HandoffAuditEntry,
  HandoffContinuationContext,
  HandoffDecision,
  HandoffOffer,
  HandoffResultMsg,
  Member,
  RoomStatus,
  RoomMode,
  RosterEntry,
  ServerMsg,
  ToolProgressState,
  TranscriptEntry,
} from "@ripieno/protocol";
import {
  MAX_GOALS,
  MAX_GOAL_AUDIT_ENTRIES,
  MAX_GOAL_REQUEST_ID_CHARS,
  MAX_GOAL_REQUESTS,
  MAX_GOAL_TEXT_CHARS,
  MAX_CONTEXT_AUDIT_ENTRIES,
  MAX_CONTEXT_BODY_CHARS,
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_REQUEST_ID_CHARS,
  MAX_CONTEXT_REQUESTS,
  MAX_CONTEXT_TAG_CHARS,
  MAX_CONTEXT_TAGS,
  MAX_CONTEXT_TITLE_CHARS,
  HANDOFF_EXPIRY_MS,
  MAX_HANDOFFS,
  MAX_HANDOFF_AUDIT_ENTRIES,
  MAX_HANDOFF_CONTEXT_ACTIONS,
  MAX_HANDOFF_CONTEXT_CHARS,
  MAX_HANDOFF_CONTEXT_GOALS,
  MAX_HANDOFF_CONTEXT_TRANSCRIPT,
  MAX_HANDOFF_REQUEST_ID_CHARS,
  MAX_HANDOFF_REQUESTS,
  MAX_HANDOFF_TASK_CHARS,
  MAX_HANDOFF_OUTCOME_CHARS,
  MAX_PRESENCE_PATH_CHARS,
  MAX_PRESENCE_SUMMARY_CHARS,
  WORKSPACE_HANDLE,
} from "@ripieno/protocol";
import { toRosterEntry } from "./roomCore.js";
import type { RoomDriver } from "./driver.js";
import type { AgentUsage, RoomRole, TurnUsage } from "@ripieno/protocol";
import type {
  ContextRequestReceipt,
  GoalRequestReceipt,
  HandoffRequestReceipt,
  RoomSnapshot,
} from "./roomStore.js";

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
  capability: AgentCapability;
  /** Last reported activity. Absent until its host says — see AgentActivity. */
  state?: AgentActivity;
  activity?: AgentPresence;
  /**
   * Highest presence sequence this socket has had accepted.
   *
   * Per connection, so it dies with the connection: a reattaching agent starts
   * again from nothing rather than inheriting a number it must now beat.
   */
  activitySequence?: number;
  /** When presence for this agent was last put on the wire. */
  activityPublishedAt?: number;
  /** The newest presence held back by the rate limit, published on the flush. */
  activityPending?: AgentPresence;
  activityTimer?: NodeJS.Timeout;
}

/** Identifies an agent connection; humans are identified by handle alone. */
export interface AgentIdentity {
  id: string;
  label: string;
  capability?: AgentCapability;
}

export interface ContextMutationActor {
  handle: string;
  role: ConnectionRole;
  agentId?: string;
  agentLabel?: string;
}

export class Room {
  /**
   * Every socket a member is reachable at, keyed by handle rather than by
   * device — one person may be at two machines at once (a laptop and a
   * desktop), and the second must not evict the first, exactly as one person's
   * several agents must not evict each other.
   *
   * The roster stays one entry per handle: two of someone's machines are the
   * same person, not two members. The invariant that keeps it that way is that
   * a handle is a key here only while it has at least one live socket — so
   * `connections.has(handle)` is still "are they present" and
   * `connections.size` is still how many members are.
   */
  private readonly connections = new Map<string, Set<Connection>>();
  /**
   * Each member's own agents, keyed by agent id rather than by handle — one
   * person may run several at once (a coder and a reviewer, say), and they must
   * not evict each other or their owner's editor connection.
   */
  private readonly agents = new Map<string, AgentConnection>();
  /** Durable room-level revocation: released source ids cannot race or reconnect. */
  private readonly releasedAgents = new Set<string>();
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
  /** Durable goals and their mutation history are authoritative here. */
  private readonly goals = new Map<string, Goal>();
  private readonly goalAudit: GoalAuditEntry[] = [];
  private readonly goalRequests = new Map<string, GoalRequestReceipt>();
  private roomRevision = 0;
  /** Durable, attributed room memory shared by people and agents. */
  private readonly context = new Map<string, ContextItem>();
  private readonly contextAudit: ContextAuditEntry[] = [];
  private readonly contextRequests = new Map<string, ContextRequestReceipt>();
  private contextRevision = 0;
  /** Relay-authoritative, durable transfers of responsibility between local agents. */
  private readonly handoffs = new Map<string, HandoffOffer>();
  private readonly handoffAudit: HandoffAuditEntry[] = [];
  private readonly handoffRequests = new Map<string, HandoffRequestReceipt>();
  private handoffRevision = 0;
  private handoffExpiryTimer: NodeJS.Timeout | undefined;
  /** Runs only while some agent has live presence to expire. */
  private presenceSweepTimer: NodeJS.Timeout | undefined;
  /**
   * Presence pacing, read on every use.
   *
   * Four frames a second per agent is fast enough to look live and slow enough
   * that a chatty provider cannot turn one turn into thousands of roster
   * broadcasts. Tests shorten these; nothing in production changes them.
   */
  static readonly presenceLimits = {
    /** At most four published presence frames a second, per agent. */
    minIntervalMs: 250,
    /** Presence nobody has refreshed within this is no longer shown. */
    ttlMs: 45_000,
    sweepMs: 5_000,
  };
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
  hydrate(snapshot: RoomSnapshot): boolean {
    for (const member of snapshot.members) {
      if (!this.known.has(member.handle)) this.known.set(member.handle, member);
    }
    for (const [handle, role] of Object.entries(snapshot.roles ?? {})) {
      this.roles.set(handle, role);
    }
    for (const entry of snapshot.usage ?? []) this.usage.set(entry.agentId, entry);
    this.transcript.push(...snapshot.transcript.slice(-Room.MAX_TRANSCRIPT));
    this.actions.push(...snapshot.actions.slice(-Room.MAX_ACTIONS));
    for (const goal of (snapshot.goals ?? []).slice(-MAX_GOALS)) this.goals.set(goal.id, goal);
    this.goalAudit.push(...(snapshot.goalAudit ?? []).slice(-MAX_GOAL_AUDIT_ENTRIES));
    for (const receipt of (snapshot.goalRequests ?? []).slice(-MAX_GOAL_REQUESTS)) {
      if (
        typeof receipt.actorHandle === "string" &&
        (receipt.kind === "create" || receipt.kind === "transition")
      ) {
        this.goalRequests.set(goalRequestKey(receipt.actorHandle, receipt.requestId), receipt);
      }
    }
    this.roomRevision = Number.isSafeInteger(snapshot.roomRevision) ? snapshot.roomRevision! : 0;
    for (const item of (snapshot.context ?? []).slice(-MAX_CONTEXT_ITEMS)) {
      if (item?.id) this.context.set(item.id, structuredClone(item));
    }
    this.contextAudit.push(
      ...(snapshot.contextAudit ?? []).slice(-MAX_CONTEXT_AUDIT_ENTRIES).map((entry) => ({ ...entry }))
    );
    for (const receipt of (snapshot.contextRequests ?? []).slice(-MAX_CONTEXT_REQUESTS)) {
      if (
        typeof receipt.actorKey === "string" &&
        (receipt.kind === "create" || receipt.kind === "update")
      ) {
        this.contextRequests.set(
          contextRequestKey(receipt.actorKey, receipt.requestId),
          structuredClone(receipt)
        );
      }
    }
    this.contextRevision = Number.isSafeInteger(snapshot.contextRevision)
      ? snapshot.contextRevision!
      : 0;
    const recoveredHandoffs: Array<{
      handoff: HandoffOffer;
      from: HandoffAuditEntry["fromStatus"];
      reason: string;
    }> = [];
    for (const handoff of (snapshot.handoffs ?? []).slice(-MAX_HANDOFFS)) {
      if (!handoff?.id || !handoff?.nonce) continue;
      // A relay upgrade cannot safely replay the old one-shot accepted shape.
      if ((handoff.status as string) === "accepted") {
        const reason = "legacy delivery outcome unknown after relay upgrade";
        handoff.status = "outcomeUnknown";
        handoff.version += 1;
        handoff.updatedAt = Date.now();
        handoff.finishedAt = handoff.updatedAt;
        handoff.decisionReason = reason;
        recoveredHandoffs.push({ handoff, from: undefined, reason });
      } else if (handoff.status === "started") {
        const reason = "relay restarted after start before a durable outcome";
        handoff.status = "outcomeUnknown";
        handoff.version += 1;
        handoff.updatedAt = Date.now();
        handoff.finishedAt = handoff.updatedAt;
        handoff.decisionReason = reason;
        recoveredHandoffs.push({ handoff, from: "started", reason });
      }
      this.handoffs.set(handoff.id, handoff);
      if (["claimed", "started", "completed", "failed", "outcomeUnknown"].includes(handoff.status)) {
        this.releasedAgents.add(handoff.sourceAgentId);
      }
    }
    this.handoffAudit.push(
      ...(snapshot.handoffAudit ?? []).slice(-MAX_HANDOFF_AUDIT_ENTRIES)
    );
    for (const receipt of (snapshot.handoffRequests ?? []).slice(-MAX_HANDOFF_REQUESTS)) {
      if (
        typeof receipt.actorHandle === "string" &&
        (receipt.kind === "offer" || receipt.kind === "decision")
      ) {
        this.handoffRequests.set(
          handoffRequestKey(receipt.actorHandle, receipt.requestId),
          receipt
        );
      }
    }
    this.handoffRevision = Number.isSafeInteger(snapshot.handoffRevision)
      ? snapshot.handoffRevision!
      : 0;
    for (const { handoff, from, reason } of recoveredHandoffs) {
      this.handoffRevision += 1;
      this.recordHandoffAudit(handoff, "relay", "outcomeUnknown", from, reason);
    }
    // Agent messages restored from disk are already final; without this a
    // late delta could resurrect one that finished before the restart.
    for (const entry of snapshot.transcript) {
      if (entry.kind === "agent") this.completed.add(entry.id);
    }
    this.sweepExpiredHandoffs();
    return recoveredHandoffs.length > 0;
  }

  snapshot(): RoomSnapshot {
    return {
      transcript: this.transcript,
      actions: this.actions,
      members: [...this.known.values()],
      roles: Object.fromEntries(this.roles),
      usage: this.usageReport,
      goals: this.goalList,
      goalAudit: this.goalAuditLog,
      goalRequests: [...this.goalRequests.values()],
      roomRevision: this.roomRevision,
      context: this.contextList,
      contextAudit: this.contextAuditLog,
      contextRequests: [...this.contextRequests.values()].map((receipt) => structuredClone(receipt)),
      contextRevision: this.contextRevision,
      handoffs: this.handoffList,
      handoffAudit: this.handoffAuditLog,
      handoffRequests: [...this.handoffRequests.values()],
      handoffRevision: this.handoffRevision,
    };
  }

  /** Called whenever something worth keeping changed. */
  onChanged?: () => void;
  /** Critical handoff barrier. Server wires this directly to an awaited store save. */
  onCriticalChanged?: () => Promise<void>;

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

  get goalList(): Goal[] {
    return [...this.goals.values()].map((goal) => ({ ...goal }));
  }

  get goalAuditLog(): GoalAuditEntry[] {
    return this.goalAudit.map((entry) => ({ ...entry }));
  }

  get contextList(): ContextItem[] {
    return [...this.context.values()].map((item) => structuredClone(item));
  }

  get contextAuditLog(): ContextAuditEntry[] {
    return this.contextAudit.map((entry) => ({ ...entry }));
  }

  get handoffList(): HandoffOffer[] {
    return [...this.handoffs.values()].map((handoff) => structuredClone(handoff));
  }

  get handoffAuditLog(): HandoffAuditEntry[] {
    return this.handoffAudit.map((entry) => ({ ...entry }));
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
    const agent = this.isAgentAuthorized(agentId) ? this.agents.get(agentId) : undefined;
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

  /** Current relay authority, never a role cached by a client or stale socket. */
  isAgentAuthorized(agentId: string, socket?: SocketLike): boolean {
    const agent = this.agents.get(agentId);
    return Boolean(
      agent &&
        (!socket || agent.socket === socket) &&
        !this.releasedAgents.has(agentId) &&
        this.canAct(agent.member.handle)
    );
  }

  /**
   * Change what somebody may do.
   *
   * Only the owner, and never on themselves: a room whose owner demotes
   * themselves by accident has nobody who can undo it.
   */
  async setRole(actor: string, handle: string, role: RoomRole): Promise<void> {
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
    if (role === "viewer") {
      const handoffsChanged = this.transitionHandoffsForRemoval(
        handle,
        "role revoked",
        undefined,
        true
      );
      // Role and lifecycle changes cross the same durability barrier before an
      // agent socket is closed. A restarted relay therefore cannot restore a
      // started delivery as though its target still held authority.
      await this.persistHandoffTransitions(handoffsChanged);
      // Remove authority synchronously before close events or queued frames can
      // run. Every server-side agent path also consults isAgentAuthorized.
      for (const [agentId, agent] of this.agents) {
        if (agent.member.handle !== handle) continue;
        this.agents.delete(agentId);
        // Presence dies with authority: a revoked agent must not keep a queued
        // frame that would republish it as live a quarter of a second later.
        this.clearPresenceTimer(agent);
        agent.socket.close(4003, "room role revoked; agent execution cancelled");
      }
    }
    this.system(`${this.known.get(handle)?.displayName ?? handle} is now a ${role}.`);
    this.broadcastRoster();
    this.onChanged?.();
  }

  private agentsOf(handle: string): AttachedAgent[] {
    const now = Date.now();
    return [...this.agents.values()]
      .filter((a) => a.member.handle === handle)
      .map((a) => {
        const presence = this.livePresence(a, now);
        return {
          id: a.id,
          owner: handle,
          label: a.label,
          // Stale presence is not reported as a state either: "we do not know"
          // must not render as a confident phase from several minutes ago.
          state: presence ? a.state : undefined,
          capability: a.capability,
          activity: presence ? { ...presence } : undefined,
        };
      });
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
    const agent = this.isAgentAuthorized(agentId) ? this.agents.get(agentId) : undefined;
    if (!agent || !validAgentActivity(state)) return;
    // Coarse state is presence too, so it goes through the same rate limit,
    // ordering and expiry rather than round the side of them.
    this.setAgentActivity(agentId, state);
  }

  /**
   * Publish bounded, observable, non-durable agent presence.
   *
   * Everything a host can say about itself is treated as untrusted: the phase
   * is checked against the closed set, text is redacted and capped, an exact
   * location is only claimed where the room can map it honestly, and the
   * ordering value is accepted only when it advances. Identity is never read
   * from the payload — the caller passes the id derived from the socket.
   */
  setAgentActivity(
    agentId: string,
    phase: AgentActivity,
    rawSummary?: string,
    rawPath?: string,
    rawLine?: number,
    rawEndLine?: number,
    rawSequence?: number
  ): void {
    const agent = this.isAgentAuthorized(agentId) ? this.agents.get(agentId) : undefined;
    if (!agent || !validAgentActivity(phase)) return;
    if (rawSequence !== undefined) {
      // Ordering only. A host that mints a huge sequence hurts nobody but
      // itself: coalescing is measured in time, so it cannot buy a faster rate,
      // and the socket has already decided which agent this describes.
      if (!Number.isSafeInteger(rawSequence) || rawSequence <= 0) return;
      const highest = Math.max(agent.activitySequence ?? 0, agent.activityPending?.sequence ?? 0);
      if (rawSequence <= highest) return;
      agent.activitySequence = rawSequence;
    }
    const summary = boundedOptional(rawSummary, MAX_PRESENCE_SUMMARY_CHARS);
    // An exact cross-machine location is honest only in the single shared
    // workspace. Private copies may differ and are not advertised by default.
    const path = this.host ? boundedOptional(rawPath, MAX_PRESENCE_PATH_CHARS) : undefined;
    const line = path && presenceLine(rawLine) ? rawLine : undefined;
    const endLine =
      line !== undefined && presenceLine(rawEndLine) && rawEndLine! >= line ? rawEndLine : undefined;
    const now = Date.now();
    const next: AgentPresence = {
      phase,
      summary,
      path,
      line,
      endLine,
      updatedAt: now,
      sequence: rawSequence,
    };

    // A repeat of what the room already shows is a heartbeat: it keeps the
    // presence from expiring without spending a roster broadcast on saying
    // nothing new.
    const latest = agent.activityPending ?? this.livePresence(agent, now);
    if (latest && samePresence(latest, next)) {
      latest.updatedAt = now;
      latest.sequence = rawSequence ?? latest.sequence;
      return;
    }

    const since = now - (agent.activityPublishedAt ?? 0);
    if (since < Room.presenceLimits.minIntervalMs) {
      // Coalesce rather than queue: only the newest description of an agent is
      // worth showing, and a burst must not become a burst of roster frames.
      agent.activityPending = next;
      if (!agent.activityTimer) {
        agent.activityTimer = setTimeout(() => {
          agent.activityTimer = undefined;
          this.flushAgentActivity(agent);
        }, Room.presenceLimits.minIntervalMs - since);
        agent.activityTimer.unref?.();
      }
      return;
    }
    this.publishAgentActivity(agent, next);
  }

  /** Put one coalesced frame on the wire and restart the rate-limit window. */
  private publishAgentActivity(agent: AgentConnection, presence: AgentPresence): void {
    agent.activity = presence;
    agent.state = presence.phase;
    agent.activityPending = undefined;
    agent.activityPublishedAt = Date.now();
    this.startPresenceSweep();
    this.broadcastRoster();
  }

  private flushAgentActivity(agent: AgentConnection): void {
    const pending = agent.activityPending;
    // The connection may have been replaced or revoked while the frame waited.
    if (!pending || this.agents.get(agent.id) !== agent) return;
    this.publishAgentActivity(agent, pending);
  }

  /**
   * Presence the room may still show.
   *
   * Presence is a claim about now, and a host that stops sending — because it
   * crashed, slept or lost the network — has stopped making it. Left alone the
   * inspector would show "Editing room.ts" forever, which is exactly the kind
   * of stale confidence this surface exists not to have.
   */
  private livePresence(agent: AgentConnection, now = Date.now()): AgentPresence | undefined {
    if (!agent.activity) return undefined;
    return now - agent.activity.updatedAt <= Room.presenceLimits.ttlMs ? agent.activity : undefined;
  }

  private startPresenceSweep(): void {
    if (this.presenceSweepTimer) return;
    this.presenceSweepTimer = setInterval(
      () => this.sweepStalePresence(),
      Room.presenceLimits.sweepMs
    );
    this.presenceSweepTimer.unref?.();
  }

  /**
   * Drop presence nobody has refreshed, and tell the room once.
   *
   * Read paths already hide stale presence; this exists so the hiding is
   * actually delivered to open inspectors rather than waiting for the next
   * unrelated roster change.
   */
  sweepStalePresence(): void {
    const now = Date.now();
    let changed = false;
    let live = 0;
    for (const agent of this.agents.values()) {
      if (!agent.activity) continue;
      if (now - agent.activity.updatedAt > Room.presenceLimits.ttlMs) {
        agent.activity = undefined;
        agent.state = undefined;
        agent.activityPending = undefined;
        this.clearPresenceTimer(agent);
        changed = true;
      } else {
        live += 1;
      }
    }
    if (live === 0 && this.presenceSweepTimer) {
      clearInterval(this.presenceSweepTimer);
      this.presenceSweepTimer = undefined;
    }
    if (changed) this.broadcastRoster();
  }

  private clearPresenceTimer(agent: AgentConnection): void {
    if (agent.activityTimer) clearTimeout(agent.activityTimer);
    agent.activityTimer = undefined;
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
    this.sweepExpiredHandoffs();
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

    // A second machine belonging to somebody already here is not an arrival:
    // the roster has one entry for them either way, and announcing it again
    // would fill the transcript with one person's laptops greeting each other.
    const announceArrival = role === "agent" || !this.connections.has(member.handle);

    let label: string;
    let myAgentId: string | undefined;
    if (role === "agent") {
      const id = (myAgentId = agent?.id ?? `${member.handle}:default`);
      label = agent?.label ?? `${member.displayName}'s agent`;
      if (!this.canAct(member.handle)) {
        this.sendTo(socket, { t: "error", message: "Viewers cannot attach agents to this room." });
        socket.close(4003, "viewer");
        return;
      }
      if (this.releasedAgents.has(id)) {
        this.sendTo(socket, {
          t: "error",
          message: "This source agent was released by a completed handoff claim.",
        });
        socket.close(4004, "responsibility already transferred");
        return;
      }
      // Replacing by *agent id* — not by handle — is what lets one person run
      // several agents at once without them evicting each other.
      const replaced = this.agents.get(id);
      if (replaced) {
        this.clearPresenceTimer(replaced);
        replaced.socket.close(4000, `another connection claimed the agent id ${id}`);
      }
      this.agents.set(id, {
        member,
        socket,
        id,
        label,
        capability: agent?.capability ?? "conversation",
      });
    } else {
      label = member.displayName;
      // Added, not swapped in. Keying the *set* by handle and the entries by
      // socket is what lets one identity hold two sessions at once; closing the
      // one already there is what used to stop it.
      const live = this.connections.get(member.handle);
      if (live) live.add({ member, socket });
      else this.connections.set(member.handle, new Set([{ member, socket }]));
    }

    this.sendTo(socket, {
      t: "joined",
      room: this.code,
      mode: this.mode,
      workspaceHost: this.host,
      actions: this.actions,
      usage: this.usageReport,
      goals: this.goalList,
      goalAudit: this.goalAuditLog,
      roomRevision: this.roomRevision,
      context: this.contextList,
      contextAudit: this.contextAuditLog,
      contextRevision: this.contextRevision,
      handoffs: this.handoffList,
      handoffAudit: this.handoffAuditLog,
      handoffRevision: this.handoffRevision,
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
    if (announceArrival) this.system(`${label} joined the room.`);
    this.broadcastRoster();
    this.scheduleHandoffExpiry();
    if (role === "agent" && myAgentId) this.replayHandoffDelivery(myAgentId);
    await this.tellDriver();
  }

  /** Create a durable goal owned by the authenticated human actor. */
  createGoal(actor: string, requestId: string, rawText: string): GoalResultMsg {
    const fingerprint = goalRequestFingerprint({ actor, kind: "create", text: rawText });
    const replay = this.replayGoalRequest(actor, requestId, fingerprint);
    if (replay) return replay;
    if (!validGoalRequestId(requestId)) {
      return this.goalFailure(requestId, "Goal request ID is invalid.");
    }
    if (!this.connections.has(actor) || isContainer(actor)) {
      return this.rememberGoalResult(
        actor,
        requestId,
        fingerprint,
        "create",
        undefined,
        this.goalFailure(requestId, "Only a present human member can create a goal.")
      );
    }
    if (!this.canAct(actor)) {
      return this.rememberGoalResult(
        actor,
        requestId,
        fingerprint,
        "create",
        undefined,
        this.goalFailure(requestId, "Viewers cannot create goals.")
      );
    }
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (text.length === 0 || text.length > MAX_GOAL_TEXT_CHARS) {
      return this.rememberGoalResult(
        actor,
        requestId,
        fingerprint,
        "create",
        undefined,
        this.goalFailure(requestId, `A goal must be 1-${MAX_GOAL_TEXT_CHARS} characters.`)
      );
    }
    if (this.goals.size >= MAX_GOALS && !this.reclaimOldestCompletedGoal()) {
      return this.rememberGoalResult(
        actor,
        requestId,
        fingerprint,
        "create",
        undefined,
        this.goalFailure(requestId, `This room already has the maximum of ${MAX_GOALS} goals.`)
      );
    }

    const now = Date.now();
    const goal: Goal = {
      id: `goal_${randomUUID()}`,
      text,
      ownerHandle: actor,
      ownerName: this.known.get(actor)?.displayName ?? actor,
      status: "active",
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.goals.set(goal.id, goal);
    this.roomRevision += 1;
    this.recordGoalAudit(goal, requestId, actor, "create", undefined);
    const result: GoalResultMsg = {
      t: "goalResult",
      requestId,
      ok: true,
      roomRevision: this.roomRevision,
      goal: { ...goal },
      goals: this.goalList,
      goalAudit: this.goalAuditLog,
    };
    this.rememberGoalResult(actor, requestId, fingerprint, "create", goal.id, result);
    this.broadcastGoals();
    this.onChanged?.();
    return result;
  }

  /** Apply one legal goal transition with ownership and version checks. */
  transitionGoal(
    actor: string,
    requestId: string,
    goalId: string,
    action: GoalTransition,
    expectedVersion: number
  ): GoalResultMsg {
    const fingerprint = goalRequestFingerprint({
      actor,
      kind: "transition",
      goalId,
      action,
      expectedVersion,
    });
    const replay = this.replayGoalRequest(actor, requestId, fingerprint);
    if (replay) return replay;
    if (!validGoalRequestId(requestId)) {
      return this.goalFailure(requestId, "Goal request ID is invalid.");
    }

    const fail = (message: string): GoalResultMsg =>
      this.rememberGoalResult(
        actor,
        requestId,
        fingerprint,
        "transition",
        typeof goalId === "string" ? goalId : undefined,
        this.goalFailure(requestId, message)
      );
    if (!this.connections.has(actor) || isContainer(actor)) {
      return fail("Only a present human member can change a goal.");
    }
    if (!this.canAct(actor)) return fail("Viewers cannot change goals.");
    const goal = typeof goalId === "string" ? this.goals.get(goalId) : undefined;
    if (!goal) return fail("Goal not found. Use /goal list to refresh the available IDs.");
    if (goal.ownerHandle !== actor && this.roleOf(actor) !== "owner") {
      return fail("Only the goal owner or room owner can change this goal.");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== goal.version) {
      return fail(`Goal changed since you last saw it (current version ${goal.version}).`);
    }

    const next = nextGoalStatus(goal.status, action);
    if (!next) return fail(`Cannot ${action} a ${goal.status} goal.`);
    const before = goal.status;
    const now = Date.now();
    goal.status = next;
    goal.version += 1;
    goal.updatedAt = now;
    if (next === "completed") goal.completedAt = now;
    this.roomRevision += 1;
    this.recordGoalAudit(goal, requestId, actor, action, before);
    const result: GoalResultMsg = {
      t: "goalResult",
      requestId,
      ok: true,
      roomRevision: this.roomRevision,
      goal: { ...goal },
      goals: this.goalList,
      goalAudit: this.goalAuditLog,
    };
    this.rememberGoalResult(actor, requestId, fingerprint, "transition", goal.id, result);
    this.broadcastGoals();
    this.onChanged?.();
    return result;
  }

  private replayGoalRequest(
    actor: string,
    requestId: string,
    fingerprint: string
  ): GoalResultMsg | undefined {
    if (!validGoalRequestId(requestId)) return undefined;
    const prior = this.goalRequests.get(goalRequestKey(actor, requestId));
    if (!prior) return undefined;
    if (prior.fingerprint === fingerprint) {
      if (!prior.result.ok) return { ...prior.result };
      const current = prior.goalId ? this.goals.get(prior.goalId) : undefined;
      return {
        ...prior.result,
        roomRevision: this.roomRevision,
        goal: current ? { ...current } : undefined,
        goals: this.goalList,
        goalAudit: this.goalAuditLog,
      };
    }
    return this.goalFailure(requestId, "That request ID was already used for a different goal mutation.");
  }

  private goalFailure(requestId: string, message: string): GoalResultMsg {
    return { t: "goalResult", requestId, ok: false, roomRevision: this.roomRevision, message };
  }

  private rememberGoalResult(
    actorHandle: string,
    requestId: string,
    fingerprint: string,
    kind: GoalRequestReceipt["kind"],
    goalId: string | undefined,
    result: GoalResultMsg
  ): GoalResultMsg {
    const key = goalRequestKey(actorHandle, requestId);
    this.goalRequests.set(key, {
      actorHandle,
      requestId,
      fingerprint,
      kind,
      goalId,
      result: durableGoalResult(result),
    });
    while (this.goalRequests.size > MAX_GOAL_REQUESTS) {
      // A successful create receipt is the durable identity of a live goal.
      // Evict failed/transition churn first, deterministically oldest-first.
      const evictable = [...this.goalRequests.entries()].find(
        ([, receipt]) =>
          !(
            receipt.kind === "create" &&
            receipt.result.ok &&
            receipt.goalId !== undefined &&
            this.goals.has(receipt.goalId)
          )
      );
      if (!evictable) break; // MAX_GOALS < MAX_GOAL_REQUESTS, so defensive only.
      this.goalRequests.delete(evictable[0]);
    }
    this.onChanged?.();
    return result;
  }

  private recordGoalAudit(
    goal: Goal,
    requestId: string,
    actor: string,
    action: "create" | GoalTransition,
    fromStatus: Goal["status"] | undefined
  ): void {
    this.goalAudit.push({
      id: randomUUID(),
      goalId: goal.id,
      requestId,
      actorHandle: actor,
      action,
      fromStatus,
      toStatus: goal.status,
      goalVersion: goal.version,
      roomRevision: this.roomRevision,
      ts: Date.now(),
    });
    if (this.goalAudit.length > MAX_GOAL_AUDIT_ENTRIES) {
      this.goalAudit.splice(0, this.goalAudit.length - MAX_GOAL_AUDIT_ENTRIES);
    }
  }

  private broadcastGoals(): void {
    this.broadcast({
      t: "goals",
      goals: this.goalList,
      goalAudit: this.goalAuditLog,
      roomRevision: this.roomRevision,
    });
  }

  /** Make room only by retiring the oldest completed goal. Live work is never displaced. */
  private reclaimOldestCompletedGoal(): boolean {
    const completed = [...this.goals.values()]
      .filter((goal) => goal.status === "completed")
      .sort(
        (left, right) =>
          (left.completedAt ?? left.updatedAt) - (right.completedAt ?? right.updatedAt) ||
          left.createdAt - right.createdAt
      )[0];
    if (!completed) return false;
    this.goals.delete(completed.id);
    for (let index = this.goalAudit.length - 1; index >= 0; index--) {
      if (this.goalAudit[index]!.goalId === completed.id) this.goalAudit.splice(index, 1);
    }
    for (const [key, receipt] of this.goalRequests) {
      if (receipt.goalId === completed.id) this.goalRequests.delete(key);
    }
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Durable shared room context                                     */
  /* ---------------------------------------------------------------- */

  createContext(
    actor: ContextMutationActor,
    requestId: string,
    rawKind: ContextKind,
    rawTitle: string,
    rawBody: string,
    rawTags?: string[]
  ): ContextResultMsg {
    const actorKey = contextActorKey(actor);
    const fingerprint = contextRequestFingerprint({
      actorKey,
      kind: "create",
      contextKind: rawKind,
      title: rawTitle,
      body: rawBody,
      tags: rawTags,
    });
    const replay = this.replayContextRequest(actorKey, requestId, fingerprint);
    if (replay) return replay;
    if (!validContextRequestId(requestId)) {
      return this.contextFailure(requestId, "Context request ID is invalid.");
    }
    const fail = (message: string): ContextResultMsg =>
      this.rememberContextResult(
        actorKey,
        requestId,
        fingerprint,
        "create",
        undefined,
        this.contextFailure(requestId, message)
      );
    const actorError = this.contextActorError(actor);
    if (actorError) return fail(actorError);
    if (!validContextKind(rawKind)) return fail("Choose a valid context kind.");

    const title = normaliseContextText(rawTitle, MAX_CONTEXT_TITLE_CHARS);
    const body = normaliseContextText(rawBody, MAX_CONTEXT_BODY_CHARS, true);
    const tags = normaliseContextTags(rawTags);
    if (!title) return fail(`A context title must be 1-${MAX_CONTEXT_TITLE_CHARS} characters.`);
    if (body === undefined) return fail(`Context body must be at most ${MAX_CONTEXT_BODY_CHARS} characters.`);
    if (!tags) {
      return fail(
        `Use at most ${MAX_CONTEXT_TAGS} tags of 1-${MAX_CONTEXT_TAG_CHARS} characters each.`
      );
    }
    if (this.context.size >= MAX_CONTEXT_ITEMS && !this.reclaimOldestTerminalContext()) {
      return fail(`This room already has the maximum of ${MAX_CONTEXT_ITEMS} live context items.`);
    }

    const now = Date.now();
    const item: ContextItem = {
      id: `context_${randomUUID()}`,
      kind: rawKind,
      title,
      body,
      tags,
      status: actor.role === "agent" ? "proposed" : "accepted",
      authorHandle: actor.handle,
      authorName: this.known.get(actor.handle)?.displayName ?? actor.handle,
      authorAgentId: actor.role === "agent" ? actor.agentId : undefined,
      authorAgentLabel: actor.role === "agent" ? actor.agentLabel : undefined,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.context.set(item.id, item);
    this.contextRevision += 1;
    this.recordContextAudit(item, requestId, actor, "create", undefined);
    const result: ContextResultMsg = {
      t: "contextResult",
      requestId,
      ok: true,
      contextRevision: this.contextRevision,
      item: structuredClone(item),
      context: this.contextList,
      contextAudit: this.contextAuditLog,
    };
    this.rememberContextResult(actorKey, requestId, fingerprint, "create", item.id, result);
    this.broadcastContext();
    this.onChanged?.();
    return result;
  }

  updateContext(
    actor: ContextMutationActor,
    requestId: string,
    contextId: string,
    expectedVersion: number,
    changes: {
      title?: string;
      body?: string;
      tags?: string[];
      status?: Exclude<ContextStatus, "proposed">;
    }
  ): ContextResultMsg {
    const actorKey = contextActorKey(actor);
    const fingerprint = contextRequestFingerprint({
      actorKey,
      kind: "update",
      contextId,
      expectedVersion,
      changes,
    });
    const replay = this.replayContextRequest(actorKey, requestId, fingerprint);
    if (replay) return replay;
    if (!validContextRequestId(requestId)) {
      return this.contextFailure(requestId, "Context request ID is invalid.");
    }
    const fail = (message: string): ContextResultMsg =>
      this.rememberContextResult(
        actorKey,
        requestId,
        fingerprint,
        "update",
        typeof contextId === "string" ? contextId : undefined,
        this.contextFailure(requestId, message)
      );
    const actorError = this.contextActorError(actor);
    if (actorError) return fail(actorError);
    const item = typeof contextId === "string" ? this.context.get(contextId) : undefined;
    if (!item) return fail("Context item not found. Refresh the Context tab and try again.");
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== item.version) {
      return fail(`Context changed since you last saw it (current version ${item.version}).`);
    }

    const editing =
      changes.title !== undefined || changes.body !== undefined || changes.tags !== undefined;
    const transitioning = changes.status !== undefined;
    if (editing === transitioning) {
      return fail("Edit context text or change its status in one request, not both.");
    }

    if (actor.role === "agent") {
      if (transitioning) return fail("Agents can propose context; a person must accept or retire it.");
      if (item.authorAgentId !== actor.agentId || item.status !== "proposed") {
        return fail("An agent may edit only its own proposed context.");
      }
    } else if (editing && item.authorHandle !== actor.handle && this.roleOf(actor.handle) !== "owner") {
      return fail("Only the context author or room owner may edit this item.");
    }

    const before = item.status;
    let action: ContextAuditEntry["action"] = "edit";
    if (transitioning) {
      if (actor.role !== "human") return fail("Only a person may change context status.");
      const next = changes.status!;
      if (!validContextTransition(item.status, next)) {
        return fail(`Cannot change ${item.status} context to ${next}.`);
      }
      if (
        next !== "accepted" &&
        item.authorHandle !== actor.handle &&
        this.roleOf(actor.handle) !== "owner"
      ) {
        return fail("Only the context author or room owner may retire this item.");
      }
      item.status = next;
      action = next === "accepted" ? "accept" : next === "archived" ? "archive" : "supersede";
    } else {
      const title =
        changes.title === undefined
          ? item.title
          : normaliseContextText(changes.title, MAX_CONTEXT_TITLE_CHARS);
      const body =
        changes.body === undefined
          ? item.body
          : normaliseContextText(changes.body, MAX_CONTEXT_BODY_CHARS, true);
      const tags = changes.tags === undefined ? item.tags : normaliseContextTags(changes.tags);
      if (!title) return fail(`A context title must be 1-${MAX_CONTEXT_TITLE_CHARS} characters.`);
      if (body === undefined) return fail(`Context body must be at most ${MAX_CONTEXT_BODY_CHARS} characters.`);
      if (!tags) {
        return fail(
          `Use at most ${MAX_CONTEXT_TAGS} tags of 1-${MAX_CONTEXT_TAG_CHARS} characters each.`
        );
      }
      item.title = title;
      item.body = body;
      item.tags = tags;
    }

    item.version += 1;
    item.updatedAt = Date.now();
    this.contextRevision += 1;
    this.recordContextAudit(item, requestId, actor, action, before);
    const result: ContextResultMsg = {
      t: "contextResult",
      requestId,
      ok: true,
      contextRevision: this.contextRevision,
      item: structuredClone(item),
      context: this.contextList,
      contextAudit: this.contextAuditLog,
    };
    this.rememberContextResult(actorKey, requestId, fingerprint, "update", item.id, result);
    this.broadcastContext();
    this.onChanged?.();
    return result;
  }

  private contextActorError(actor: ContextMutationActor): string | undefined {
    if (actor.role === "workspace" || isContainer(actor.handle)) {
      return "The shared workspace cannot author room context.";
    }
    if (!this.canAct(actor.handle)) return "Viewers cannot change room context.";
    if (actor.role === "human") {
      return this.connections.has(actor.handle)
        ? undefined
        : "Only a present room member can change context.";
    }
    const connected = actor.agentId ? this.agents.get(actor.agentId) : undefined;
    return connected &&
      connected.member.handle === actor.handle &&
      this.isAgentAuthorized(connected.id)
      ? undefined
      : "Only an attached, authorised agent can change context.";
  }

  private replayContextRequest(
    actorKey: string,
    requestId: string,
    fingerprint: string
  ): ContextResultMsg | undefined {
    if (!validContextRequestId(requestId)) return undefined;
    const prior = this.contextRequests.get(contextRequestKey(actorKey, requestId));
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint) {
      return this.contextFailure(
        requestId,
        "That request ID was already used for a different context mutation."
      );
    }
    if (!prior.result.ok) return { ...prior.result };
    const current = prior.contextId ? this.context.get(prior.contextId) : undefined;
    return {
      ...prior.result,
      contextRevision: this.contextRevision,
      item: current ? structuredClone(current) : undefined,
      context: this.contextList,
      contextAudit: this.contextAuditLog,
    };
  }

  private contextFailure(requestId: string, message: string): ContextResultMsg {
    return {
      t: "contextResult",
      requestId,
      ok: false,
      contextRevision: this.contextRevision,
      message,
    };
  }

  private rememberContextResult(
    actorKey: string,
    requestId: string,
    fingerprint: string,
    kind: ContextRequestReceipt["kind"],
    contextId: string | undefined,
    result: ContextResultMsg
  ): ContextResultMsg {
    this.contextRequests.set(contextRequestKey(actorKey, requestId), {
      actorKey,
      requestId,
      fingerprint,
      kind,
      contextId,
      result: durableContextResult(result),
    });
    while (this.contextRequests.size > MAX_CONTEXT_REQUESTS) {
      const evictable = [...this.contextRequests.entries()].find(
        ([, receipt]) =>
          !(
            receipt.kind === "create" &&
            receipt.result.ok &&
            receipt.contextId !== undefined &&
            this.context.has(receipt.contextId)
          )
      );
      if (!evictable) break;
      this.contextRequests.delete(evictable[0]);
    }
    this.onChanged?.();
    return result;
  }

  private recordContextAudit(
    item: ContextItem,
    requestId: string,
    actor: ContextMutationActor,
    action: ContextAuditEntry["action"],
    fromStatus: ContextStatus | undefined
  ): void {
    this.contextAudit.push({
      id: randomUUID(),
      contextId: item.id,
      requestId,
      actorHandle: actor.handle,
      actorAgentId: actor.role === "agent" ? actor.agentId : undefined,
      actorAgentLabel: actor.role === "agent" ? actor.agentLabel : undefined,
      action,
      fromStatus,
      toStatus: item.status,
      contextVersion: item.version,
      contextRevision: this.contextRevision,
      ts: Date.now(),
    });
    if (this.contextAudit.length > MAX_CONTEXT_AUDIT_ENTRIES) {
      this.contextAudit.splice(0, this.contextAudit.length - MAX_CONTEXT_AUDIT_ENTRIES);
    }
  }

  private broadcastContext(): void {
    this.broadcast({
      t: "context",
      context: this.contextList,
      contextAudit: this.contextAuditLog,
      contextRevision: this.contextRevision,
    });
  }

  /**
   * Make room only by retiring the oldest already-terminal item.
   *
   * The item goes; its audit trail does not. Attribution is the whole point of
   * this store, and a history that quietly loses entries whenever the room gets
   * busy is not one anybody can rely on — the audit log is separately bounded
   * and evicts oldest-first on its own terms.
   *
   * The idempotency receipts stay for a nearer reason: dropping them would let
   * a retry of the original create mint a second item, so a reclaim would turn
   * a duplicate-safe request into a duplicating one. They are reclaimed under
   * pressure by `rememberContextResult`, which already prefers receipts whose
   * item is gone.
   */
  private reclaimOldestTerminalContext(): boolean {
    const terminal = [...this.context.values()]
      .filter((item) => item.status === "archived" || item.status === "superseded")
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt)[0];
    if (!terminal) return false;
    this.context.delete(terminal.id);
    return true;
  }

  /* ---------------------------------------------------------------- */
  /* Explicit agent handoff                                           */
  /* ---------------------------------------------------------------- */

  /** Offer responsibility for one of the actor's present agents to another member. */
  createHandoff(
    actor: string,
    requestId: string,
    rawTargetHandle: string,
    requestedSourceAgentId: string | undefined,
    rawTask: string
  ): HandoffResultMsg {
    this.sweepExpiredHandoffs();
    const fingerprint = handoffRequestFingerprint({
      actor,
      kind: "offer",
      targetHandle: rawTargetHandle,
      sourceAgentId: requestedSourceAgentId,
      task: rawTask,
    });
    const replay = this.replayHandoffRequest(actor, requestId, fingerprint);
    if (replay) return replay;
    if (!validHandoffRequestId(requestId)) {
      return this.handoffFailure(requestId, "Handoff request ID is invalid.");
    }
    const fail = (message: string): HandoffResultMsg =>
      this.rememberHandoffResult(
        actor,
        requestId,
        fingerprint,
        "offer",
        undefined,
        this.handoffFailure(requestId, message)
      );
    if (!this.connections.has(actor) || isContainer(actor)) {
      return fail("Only a present human member can offer a handoff.");
    }
    if (!this.canAct(actor)) return fail("Viewers cannot offer handoffs.");

    const task = typeof rawTask === "string" ? rawTask.trim() : "";
    if (task.length === 0 || task.length > MAX_HANDOFF_TASK_CHARS) {
      return fail(`A handoff task must be 1-${MAX_HANDOFF_TASK_CHARS} characters.`);
    }

    const targetHandle =
      typeof rawTargetHandle === "string" ? rawTargetHandle.trim().replace(/^@/, "") : "";
    if (!targetHandle || targetHandle === actor || isContainer(targetHandle)) {
      return fail("Choose another present human member for the handoff.");
    }
    if (!this.connections.has(targetHandle)) {
      return fail(`@${targetHandle} must be present before a handoff can be offered.`);
    }
    if (!this.canAct(targetHandle)) {
      return fail(`@${targetHandle} is a viewer and cannot accept responsibility for an agent.`);
    }

    const ownedSources = [...this.agents.values()].filter(
      (agent) => agent.member.handle === actor
    );
    const source = requestedSourceAgentId
      ? ownedSources.find((agent) => agent.id === requestedSourceAgentId)
      : ownedSources.length === 1
        ? ownedSources[0]
        : undefined;
    if (!source) {
      return fail(
        requestedSourceAgentId
          ? "The source agent is not present or is not owned by you."
          : ownedSources.length === 0
            ? "Attach one of your agents before offering a handoff."
            : "Choose which of your present agents to hand off."
      );
    }

    if (this.handoffs.size >= MAX_HANDOFFS && !this.reclaimOldestTerminalHandoff()) {
      return fail(`This room already has the maximum of ${MAX_HANDOFFS} pending handoffs.`);
    }

    const now = Date.now();
    const handoff: HandoffOffer = {
      id: `handoff_${randomUUID()}`,
      nonce: randomBytes(16).toString("hex"),
      task,
      sourceAgentId: source.id,
      sourceAgentLabel: source.label,
      sourceOwnerHandle: actor,
      sourceOwnerName: this.known.get(actor)?.displayName ?? actor,
      targetHandle,
      targetName: this.known.get(targetHandle)?.displayName ?? targetHandle,
      status: "pending",
      version: 1,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + HANDOFF_EXPIRY_MS,
    };
    this.handoffs.set(handoff.id, handoff);
    this.handoffRevision += 1;
    this.recordHandoffAudit(handoff, actor, "offer", undefined);
    const result = this.handoffSuccess(requestId, handoff);
    this.rememberHandoffResult(actor, requestId, fingerprint, "offer", handoff.id, result);
    this.broadcastHandoffs();
    this.scheduleHandoffExpiry();
    this.onChanged?.();
    return result;
  }

  /** Assign, decline, cancel, or explicitly retry with relay-derived authority. */
  async decideHandoff(
    actor: string,
    requestId: string,
    handoffId: string,
    nonce: string,
    action: HandoffDecision,
    expectedVersion: number,
    requestedTargetAgentId?: string
  ): Promise<HandoffResultMsg> {
    this.sweepExpiredHandoffs();
    const fingerprint = handoffRequestFingerprint({
      actor,
      kind: "decision",
      handoffId,
      nonce,
      action,
      expectedVersion,
      targetAgentId: requestedTargetAgentId,
    });
    const replay = this.replayHandoffRequest(actor, requestId, fingerprint);
    if (replay) return replay;
    if (!validHandoffRequestId(requestId)) {
      return this.handoffFailure(requestId, "Handoff request ID is invalid.");
    }
    const fail = (message: string): HandoffResultMsg =>
      this.rememberHandoffResult(
        actor,
        requestId,
        fingerprint,
        "decision",
        typeof handoffId === "string" ? handoffId : undefined,
        this.handoffFailure(requestId, message)
      );
    if (!this.connections.has(actor) || isContainer(actor)) {
      return fail("Only a present human member can decide a handoff.");
    }
    const handoff = typeof handoffId === "string" ? this.handoffs.get(handoffId) : undefined;
    if (!handoff) return fail("Handoff not found. Use /handoff list to refresh the IDs.");
    if (typeof nonce !== "string" || nonce !== handoff.nonce) {
      return fail("Handoff nonce does not match the authoritative offer. Refresh with /handoff list.");
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== handoff.version) {
      return fail(`Handoff changed since you last saw it (current version ${handoff.version}).`);
    }

    let targetAgent: AgentConnection | undefined;
    if (action === "accept" || action === "retry") {
      if (actor !== handoff.targetHandle) {
        return fail("Only the named recipient can accept or retry this handoff.");
      }
      if (!this.canAct(actor)) return fail("Viewers cannot accept or retry handoffs.");
      if (action === "accept" && handoff.status !== "pending") {
        return fail(`This handoff is already ${handoff.status}; the offer is single-use.`);
      }
      if (action === "retry" && handoff.status !== "outcomeUnknown" && handoff.status !== "failed") {
        return fail("Only a failed or outcome-unknown handoff can be retried manually.");
      }
      const ownedTargets = [...this.agents.values()].filter(
        (agent) => agent.member.handle === actor && this.isAgentAuthorized(agent.id)
      );
      targetAgent = requestedTargetAgentId
        ? ownedTargets.find((agent) => agent.id === requestedTargetAgentId)
        : ownedTargets.length === 1
          ? ownedTargets[0]
          : undefined;
      if (!targetAgent) {
        return fail(
          requestedTargetAgentId
            ? "The target agent is not present or is not owned by you."
            : ownedTargets.length === 0
              ? "Attach one of your agents before accepting this handoff."
              : "Choose which of your present agents should continue the work."
        );
      }
    } else if (action === "decline") {
      if (handoff.status !== "pending") {
        return fail(`This handoff is already ${handoff.status}; the offer is single-use.`);
      }
      if (actor !== handoff.targetHandle) {
        return fail("Only the named recipient can decline this handoff.");
      }
    } else if (action === "cancel") {
      if (handoff.status !== "pending" && handoff.status !== "assigned") {
        return fail(`A ${handoff.status} handoff can no longer be cancelled.`);
      }
      if (actor !== handoff.sourceOwnerHandle && this.roleOf(actor) !== "owner") {
        return fail("Only the source agent's owner or room owner can cancel this handoff.");
      }
    } else {
      return fail("Unknown handoff decision.");
    }

    const from = handoff.status;
    const now = Date.now();
    handoff.status =
      action === "accept" || action === "retry"
        ? "assigned"
        : action === "decline"
          ? "declined"
          : "cancelled";
    handoff.version += 1;
    handoff.updatedAt = now;
    handoff.decidedBy = actor;
    handoff.decisionReason = action === "accept" ? "assigned after explicit acceptance" : action;
    if (targetAgent) {
      handoff.targetAgentId = targetAgent.id;
      handoff.targetAgentLabel = targetAgent.label;
      handoff.targetAgentCapability = targetAgent.capability;
      handoff.deliveryId = `delivery_${randomUUID()}`;
      handoff.assignedAt = now;
      delete handoff.claimedAt;
      delete handoff.startedAt;
      delete handoff.finishedAt;
      delete handoff.outcomeDetail;
      handoff.continuation = this.buildHandoffContext(handoff, targetAgent);
    }
    this.handoffRevision += 1;
    this.recordHandoffAudit(
      handoff,
      actor,
      action === "accept" ? "assign" : action,
      from,
      handoff.decisionReason
    );
    const result = this.handoffSuccess(requestId, handoff);
    this.rememberHandoffResult(actor, requestId, fingerprint, "decision", handoff.id, result);
    // Assignment identity, frozen context, consent, and idempotency receipt are
    // durable before any target socket learns it can claim work.
    await this.onCriticalChanged?.();
    this.broadcastHandoffs();
    if (targetAgent) this.deliverHandoffAssignment(handoff);
    this.scheduleHandoffExpiry();
    this.onChanged?.();
    return result;
  }

  /** The exact assigned agent claims only after its host has durably stored delivery. */
  async claimHandoff(
    agentId: string,
    handoffId: string,
    deliveryId: string,
    expectedVersion: number
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    const handoff = this.handoffs.get(handoffId);
    if (
      !agent ||
      !this.isAgentAuthorized(agentId) ||
      !handoff ||
      handoff.targetAgentId !== agentId ||
      handoff.targetHandle !== agent.member.handle ||
      handoff.deliveryId !== deliveryId
    ) return false;
    if (handoff.status === "claimed") {
      this.deliverHandoffStart(handoff);
      return true;
    }
    if (handoff.status !== "assigned" || expectedVersion !== handoff.version) return false;

    const source = this.agents.get(handoff.sourceAgentId);
    const from = handoff.status;
    handoff.status = "claimed";
    handoff.version += 1;
    handoff.updatedAt = Date.now();
    handoff.claimedAt = handoff.updatedAt;
    handoff.decisionReason = "recipient agent durably claimed assignment";
    this.handoffRevision += 1;
    this.recordHandoffAudit(handoff, agent.member.handle, "claim", from, handoff.decisionReason);

    // Revoke synchronously in Room before awaiting disk or sending a start.
    // Frames already queued behind this claim therefore fail the same guard as
    // any later reconnect attempt by the released source id.
    this.releasedAgents.add(handoff.sourceAgentId);
    if (source) {
      this.clearPresenceTimer(source);
      this.agents.delete(source.id);
    }
    await this.onCriticalChanged?.();
    this.broadcastHandoffs();
    this.broadcastRoster();
    if (source) {
      this.sendTo(source.socket, {
        t: "handoffReleased",
        handoffId: handoff.id,
        deliveryId,
      });
      source.socket.close(4004, "responsibility transferred by claimed handoff");
    }
    this.deliverHandoffStart(handoff);
    this.onChanged?.();
    return true;
  }

  /** Record the target host's durable local started marker. */
  async markHandoffStarted(
    agentId: string,
    handoffId: string,
    deliveryId: string,
    expectedVersion: number
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    const handoff = this.handoffs.get(handoffId);
    if (
      !agent ||
      !this.isAgentAuthorized(agentId) ||
      !handoff ||
      handoff.targetAgentId !== agentId ||
      handoff.deliveryId !== deliveryId
    ) {
      return false;
    }
    if (handoff.status === "started") return true;
    if (handoff.status !== "claimed" || handoff.version !== expectedVersion) return false;
    const from = handoff.status;
    handoff.status = "started";
    handoff.version += 1;
    handoff.updatedAt = Date.now();
    handoff.startedAt = handoff.updatedAt;
    handoff.decisionReason = "recipient host durably marked delivery started";
    this.handoffRevision += 1;
    this.recordHandoffAudit(handoff, agent.member.handle, "start", from, handoff.decisionReason);
    await this.onCriticalChanged?.();
    this.broadcastHandoffs();
    this.onChanged?.();
    return true;
  }

  /** Durable completion/failure/uncertainty from the exact selected target agent. */
  async reportHandoffOutcome(
    agentId: string,
    handoffId: string,
    deliveryId: string,
    outcome: "completed" | "failed" | "outcomeUnknown",
    rawDetail?: string
  ): Promise<boolean> {
    const agent = this.agents.get(agentId);
    const handoff = this.handoffs.get(handoffId);
    if (
      !agent ||
      !this.isAgentAuthorized(agentId) ||
      !handoff ||
      handoff.targetAgentId !== agentId ||
      handoff.deliveryId !== deliveryId
    ) {
      return false;
    }
    if (["completed", "failed", "outcomeUnknown"].includes(handoff.status)) {
      return handoff.status === outcome;
    }
    if (handoff.status !== "claimed" && handoff.status !== "started") return false;
    const from = handoff.status;
    handoff.status = outcome;
    handoff.version += 1;
    handoff.updatedAt = Date.now();
    handoff.finishedAt = handoff.updatedAt;
    handoff.outcomeDetail = redactHandoffText(
      typeof rawDetail === "string" ? rawDetail : ""
    ).slice(0, MAX_HANDOFF_OUTCOME_CHARS);
    handoff.decisionReason =
      outcome === "completed"
        ? "recipient agent completed the assigned turn"
        : outcome === "failed"
          ? "recipient provider reported failure"
          : "recipient host cannot prove the started provider call's outcome";
    this.handoffRevision += 1;
    this.recordHandoffAudit(
      handoff,
      agent.member.handle,
      outcome === "completed" ? "complete" : outcome === "failed" ? "fail" : "outcomeUnknown",
      from,
      handoff.decisionReason
    );
    await this.onCriticalChanged?.();
    this.broadcastHandoffs();
    this.onChanged?.();
    return true;
  }

  /** Replay only the stage that is still waiting on this exact target agent. */
  private replayHandoffDelivery(agentId: string): void {
    for (const handoff of this.handoffs.values()) {
      if (handoff.targetAgentId !== agentId) continue;
      if (handoff.status === "assigned") this.deliverHandoffAssignment(handoff);
      else if (handoff.status === "claimed") this.deliverHandoffStart(handoff);
    }
  }

  private deliverHandoffAssignment(handoff: HandoffOffer): void {
    if (
      handoff.status !== "assigned" ||
      !handoff.deliveryId ||
      !handoff.targetAgentId ||
      !handoff.continuation
    ) return;
    const target = this.agents.get(handoff.targetAgentId);
    if (!target || !this.isAgentAuthorized(target.id)) return;
    this.sendTo(target.socket, {
      t: "handoffAssignment",
      handoffId: handoff.id,
      deliveryId: handoff.deliveryId,
      handoffVersion: handoff.version,
      context: structuredClone(handoff.continuation),
    });
  }

  private deliverHandoffStart(handoff: HandoffOffer): void {
    if (
      handoff.status !== "claimed" ||
      !handoff.deliveryId ||
      !handoff.targetAgentId ||
      !handoff.continuation
    ) return;
    const target = this.agents.get(handoff.targetAgentId);
    if (!target || !this.isAgentAuthorized(target.id)) return;
    this.sendTo(target.socket, {
      t: "handoffStart",
      handoffId: handoff.id,
      deliveryId: handoff.deliveryId,
      handoffVersion: handoff.version,
      context: structuredClone(handoff.continuation),
    });
  }

  /**
   * Move every delivery affected by lost authority into an honest durable
   * state. `wholeMember` is used for demotion: all their pending/assigned work
   * is cancelled and every claimed/started target delivery becomes uncertain.
   * A single agent disconnect keeps assigned target work replayable, while
   * cancelling offers sourced by that exact agent.
   */
  private transitionHandoffsForRemoval(
    handle: string,
    reason: "disconnected" | "role revoked",
    agentId?: string,
    wholeMember = false
  ): boolean {
    let changed = false;
    const now = Date.now();
    for (const handoff of this.handoffs.values()) {
      const relevantPreClaim =
        (handoff.status === "pending" || handoff.status === "assigned") &&
        (wholeMember
          ? handoff.sourceOwnerHandle === handle || handoff.targetHandle === handle
          : handoff.sourceAgentId === agentId);
      if (relevantPreClaim) {
        const from = handoff.status;
        handoff.status = "cancelled";
        handoff.version += 1;
        handoff.updatedAt = now;
        handoff.decidedBy = "relay";
        handoff.decisionReason = reason;
        this.handoffRevision += 1;
        this.recordHandoffAudit(handoff, "relay", "cancel", from, reason);
        changed = true;
        continue;
      }
      const relevantActiveTarget =
        (handoff.status === "claimed" || handoff.status === "started") &&
        (wholeMember ? handoff.targetHandle === handle : handoff.targetAgentId === agentId);
      if (!relevantActiveTarget) continue;
      const from = handoff.status;
      handoff.status = "outcomeUnknown";
      handoff.version += 1;
      handoff.updatedAt = now;
      handoff.finishedAt = handoff.updatedAt;
      handoff.decisionReason =
        reason === "role revoked"
          ? "target authority was revoked before a durable outcome"
          : "target disconnected after claim before a durable outcome";
      this.handoffRevision += 1;
      this.recordHandoffAudit(
        handoff,
        "relay",
        "outcomeUnknown",
        from,
        handoff.decisionReason
      );
      changed = true;
    }
    this.scheduleHandoffExpiry(now);
    return changed;
  }

  private async persistHandoffTransitions(changed: boolean): Promise<void> {
    if (!changed) return;
    await this.onCriticalChanged?.();
    this.broadcastHandoffs();
    this.onChanged?.();
  }

  /** Expire elapsed offers. Public so deterministic tests can drive the clock. */
  sweepExpiredHandoffs(now = Date.now()): number {
    let changed = 0;
    for (const handoff of this.handoffs.values()) {
      if (handoff.status !== "pending" || handoff.expiresAt > now) continue;
      const from = handoff.status;
      handoff.status = "expired";
      handoff.version += 1;
      handoff.updatedAt = now;
      handoff.decidedBy = "relay";
      handoff.decisionReason = "expired";
      this.handoffRevision += 1;
      this.recordHandoffAudit(handoff, "relay", "expire", from, "expired");
      changed += 1;
    }
    if (changed > 0) {
      this.broadcastHandoffs();
      this.onChanged?.();
    }
    this.scheduleHandoffExpiry(now);
    return changed;
  }

  private async cancelPreClaimHandoffsFor(
    handle: string,
    reason: "disconnected" | "role revoked",
    agentId?: string
  ): Promise<void> {
    let changed = false;
    const now = Date.now();
    for (const handoff of this.handoffs.values()) {
      if (handoff.status !== "pending" && handoff.status !== "assigned") continue;
      const relevant = agentId
        ? handoff.sourceAgentId === agentId
        : handoff.sourceOwnerHandle === handle || handoff.targetHandle === handle;
      if (!relevant) continue;
      const from = handoff.status;
      handoff.status = "cancelled";
      handoff.version += 1;
      handoff.updatedAt = now;
      handoff.decidedBy = "relay";
      handoff.decisionReason = reason;
      this.handoffRevision += 1;
      this.recordHandoffAudit(handoff, "relay", "cancel", from, reason);
      changed = true;
    }
    if (changed) {
      await this.onCriticalChanged?.();
      this.broadcastHandoffs();
      this.onChanged?.();
    }
    this.scheduleHandoffExpiry(now);
  }

  private scheduleHandoffExpiry(now = Date.now()): void {
    if (this.handoffExpiryTimer) clearTimeout(this.handoffExpiryTimer);
    this.handoffExpiryTimer = undefined;
    const next = [...this.handoffs.values()]
      .filter((handoff) => handoff.status === "pending")
      .sort((left, right) => left.expiresAt - right.expiresAt)[0];
    if (!next) return;
    this.handoffExpiryTimer = setTimeout(
      () => this.sweepExpiredHandoffs(),
      Math.max(1, next.expiresAt - now)
    );
    this.handoffExpiryTimer.unref();
  }

  private buildHandoffContext(
    handoff: HandoffOffer,
    targetAgent: AgentConnection
  ): HandoffContinuationContext {
    const transcriptSource = this.transcript.filter((entry) => entry.kind !== "system");
    const actionSource = this.actions;
    const goalSource = this.goalList.filter((goal) => goal.status === "active");
    const transcript = transcriptSource.slice(-MAX_HANDOFF_CONTEXT_TRANSCRIPT).map((entry) => ({
      ...entry,
      authorHandle: redactHandoffText(entry.authorHandle).slice(0, 80),
      authorName: redactHandoffText(entry.authorName).slice(0, 120),
      text: redactHandoffText(entry.text).slice(0, 2_000),
    }));
    const actions = actionSource.slice(-MAX_HANDOFF_CONTEXT_ACTIONS).map((entry) => ({
      ...entry,
      agentLabel: redactHandoffText(entry.agentLabel).slice(0, 120),
      targetHandle: redactHandoffText(entry.targetHandle).slice(0, 80),
      verb: redactHandoffText(entry.verb).slice(0, 80),
      target: redactHandoffText(entry.target).slice(0, 1_000),
      detail: entry.detail ? redactHandoffText(entry.detail).slice(0, 1_000) : undefined,
    }));
    const activeGoals = goalSource.slice(-MAX_HANDOFF_CONTEXT_GOALS).map((goal) => ({
      ...goal,
      text: redactHandoffText(goal.text).slice(0, 1_000),
      ownerHandle: redactHandoffText(goal.ownerHandle).slice(0, 80),
      ownerName: redactHandoffText(goal.ownerName).slice(0, 120),
    }));
    const context: HandoffContinuationContext = {
      schemaVersion: 2,
      notice:
        "Relay-authoritative delivery metadata with untrusted quoted room content for a new " +
        "recipient-owned agent turn. This is not a provider session export or restoration.",
      handoff: {
        id: handoff.id,
        nonce: handoff.nonce,
        sourceAgentId: handoff.sourceAgentId,
        sourceAgentLabel: handoff.sourceAgentLabel,
        sourceOwnerHandle: handoff.sourceOwnerHandle,
        targetAgentId: targetAgent.id,
        targetAgentLabel: targetAgent.label,
        targetHandle: targetAgent.member.handle,
        acceptedAt: handoff.assignedAt ?? handoff.updatedAt,
        task: handoff.task,
        targetCapability: targetAgent.capability,
      },
      transcript,
      actions,
      activeGoals,
      truncated: {
        transcript: transcriptSource.length > transcript.length,
        actions: actionSource.length > actions.length,
        goals: goalSource.length > activeGoals.length,
        characters: false,
      },
    };
    while (JSON.stringify(context).length > MAX_HANDOFF_CONTEXT_CHARS) {
      context.truncated.characters = true;
      if (context.transcript.length > 1) context.transcript.shift();
      else if (context.actions.length > 0) context.actions.shift();
      else if (context.activeGoals.length > 0) context.activeGoals.shift();
      else break;
    }
    return context;
  }

  private replayHandoffRequest(
    actor: string,
    requestId: string,
    fingerprint: string
  ): HandoffResultMsg | undefined {
    if (!validHandoffRequestId(requestId)) return undefined;
    const prior = this.handoffRequests.get(handoffRequestKey(actor, requestId));
    if (!prior) return undefined;
    if (prior.fingerprint !== fingerprint) {
      return this.handoffFailure(
        requestId,
        "That request ID was already used for a different handoff mutation."
      );
    }
    if (!prior.result.ok) return { ...prior.result };
    const current = prior.handoffId ? this.handoffs.get(prior.handoffId) : undefined;
    return {
      ...prior.result,
      handoffRevision: this.handoffRevision,
      handoff: current ? structuredClone(current) : undefined,
      handoffs: this.handoffList,
      handoffAudit: this.handoffAuditLog,
    };
  }

  private handoffFailure(requestId: string, message: string): HandoffResultMsg {
    return {
      t: "handoffResult",
      requestId,
      ok: false,
      handoffRevision: this.handoffRevision,
      message,
    };
  }

  private handoffSuccess(requestId: string, handoff: HandoffOffer): HandoffResultMsg {
    return {
      t: "handoffResult",
      requestId,
      ok: true,
      handoffRevision: this.handoffRevision,
      handoff: structuredClone(handoff),
      handoffs: this.handoffList,
      handoffAudit: this.handoffAuditLog,
    };
  }

  private rememberHandoffResult(
    actorHandle: string,
    requestId: string,
    fingerprint: string,
    kind: HandoffRequestReceipt["kind"],
    handoffId: string | undefined,
    result: HandoffResultMsg
  ): HandoffResultMsg {
    this.handoffRequests.set(handoffRequestKey(actorHandle, requestId), {
      actorHandle,
      requestId,
      fingerprint,
      kind,
      handoffId,
      result: durableHandoffResult(result),
    });
    while (this.handoffRequests.size > MAX_HANDOFF_REQUESTS) {
      const evictable = [...this.handoffRequests.entries()].find(
        ([, receipt]) =>
          !(
            receipt.kind === "offer" &&
            receipt.result.ok &&
            receipt.handoffId !== undefined &&
            !isHandoffTerminal(this.handoffs.get(receipt.handoffId)?.status)
          )
      );
      if (!evictable) break;
      this.handoffRequests.delete(evictable[0]);
    }
    this.onChanged?.();
    return result;
  }

  private recordHandoffAudit(
    handoff: HandoffOffer,
    actorHandle: string,
    action: HandoffAuditEntry["action"],
    fromStatus: HandoffOffer["status"] | undefined,
    reason?: HandoffAuditEntry["reason"]
  ): void {
    this.handoffAudit.push({
      id: randomUUID(),
      handoffId: handoff.id,
      actorHandle,
      action,
      fromStatus,
      toStatus: handoff.status,
      handoffVersion: handoff.version,
      handoffRevision: this.handoffRevision,
      ts: Date.now(),
      reason,
    });
    if (this.handoffAudit.length > MAX_HANDOFF_AUDIT_ENTRIES) {
      this.handoffAudit.splice(0, this.handoffAudit.length - MAX_HANDOFF_AUDIT_ENTRIES);
    }
  }

  private broadcastHandoffs(): void {
    this.broadcast({
      t: "handoffs",
      handoffs: this.handoffList,
      handoffAudit: this.handoffAuditLog,
      handoffRevision: this.handoffRevision,
    });
  }

  private reclaimOldestTerminalHandoff(): boolean {
    const terminal = [...this.handoffs.values()]
      .filter((handoff) => isHandoffTerminal(handoff.status))
      .sort((left, right) => left.updatedAt - right.updatedAt || left.createdAt - right.createdAt)[0];
    if (!terminal) return false;
    this.handoffs.delete(terminal.id);
    for (let index = this.handoffAudit.length - 1; index >= 0; index--) {
      if (this.handoffAudit[index]!.handoffId === terminal.id) this.handoffAudit.splice(index, 1);
    }
    for (const [key, receipt] of this.handoffRequests) {
      if (receipt.handoffId === terminal.id) this.handoffRequests.delete(key);
    }
    return true;
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
      // A demotion may already have removed the map entry before WebSocket's
      // close event is queued. Lifecycle reconciliation must not depend on the
      // entry still being present; only a live replacement socket suppresses
      // the stale close event.
      if (conn && socket && conn.socket !== socket) return;
      const handoffsChanged = this.transitionHandoffsForRemoval(
        handle,
        "disconnected",
        key
      );
      await this.persistHandoffTransitions(handoffsChanged);
      if (!conn) return;
      label = conn.label;
      this.agents.delete(key);
      this.clearPresenceTimer(conn);
    } else {
      const live = this.connections.get(handle);
      if (!live) return;
      const gone = socket ? [...live].find((c) => c.socket === socket) : undefined;
      // A named socket that is not registered is a stale close event, and must
      // not take a live connection down with it. Naming no socket at all is the
      // member leaving outright, so every machine of theirs goes.
      if (socket && !gone) return;
      const identity = gone ?? [...live][0];
      label = isContainer(handle)
        ? "The shared workspace"
        : identity?.member.displayName ?? handle;
      // Whether the machine their work goes to is the one that died — asked
      // before the entry is removed, while `executorOf` can still be compared.
      const executorLeft = gone !== undefined && this.executorOf(handle) === gone;
      if (gone) live.delete(gone);
      else live.clear();
      if (live.size > 0) {
        // Another of their machines is still here, so they have not left: the
        // roster entry stands and nothing is announced. Departing on the first
        // socket to drop would flicker a two-device member in and out of the
        // roster every time either one reconnected.
        //
        // Their in-flight work is the exception. A tool call was dispatched to
        // one machine rather than all of them, so if that is the machine that
        // died, nothing that remains has been asked and nothing will answer.
        // Say so now rather than leaving the agent to burn its full timeout —
        // the same reason the full-departure path below does it. Re-dispatching
        // to the surviving machine is not the answer: the call may already have
        // written half its file on the one that went.
        if (executorLeft) this.failRemoteCallsFor(handle);
        return;
      }
      this.connections.delete(handle);
      if (!isContainer(handle)) {
        await this.cancelPreClaimHandoffsFor(handle, "disconnected");
      }
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
    if (!this.isAgentAuthorized(requester.agentId)) return;
    const target = targetHandle === "room" ? this.host : targetHandle;
    if (!target) {
      this.replyRemote(requester.agentId, requestId, "This room has no shared workspace host.", true);
      return;
    }
    const executor = this.executorOf(target);
    if (!executor) {
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
    this.sendTo(executor.socket, {
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
    this.sendToHandle(handle, {
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
    if (this.handoffExpiryTimer) clearTimeout(this.handoffExpiryTimer);
    this.handoffExpiryTimer = undefined;
    if (this.presenceSweepTimer) clearInterval(this.presenceSweepTimer);
    this.presenceSweepTimer = undefined;
    for (const agent of this.agents.values()) this.clearPresenceTimer(agent);
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
      if (!conn || !this.isAgentAuthorized(conn.id) || text.trim() === "") return;
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

    const member = this.memberOf(handle);
    if (!member || text.trim() === "") return;

    // The shared workspace is a container, not a person.
    //
    // `describeMembers` already keeps kind "workspace" out of the roster so no
    // agent is ever told the container is somebody to address. This is the same
    // principle on the transcript path, which was missed: a workspace-role
    // `say` fell through to the human branch and was appended as kind "human",
    // so every member's AgentHost ran `answersEntry`, saw a human message with
    // nobody named in it, and fired the primary-agent fallback. "Cloned
    // ijmh2/ripieno (main)." woke every primary agent in the room, each
    // spending a turn on an announcement addressed to no one.
    //
    // "system" is the kind agents do not answer at all — `answersEntry`
    // considers only "human" and "agent" — and the webview already renders it
    // as a centred note rather than a bubble with an author, which is what a
    // container announcement is. It keeps its author, because provenance is
    // the one thing this project does not throw away: the entry still records
    // which connection said it, it is only addressed to nobody.
    //
    // `trim()` discards system entries first when the transcript is full, so a
    // container announcement is evicted before anything a person said. That is
    // the right trade here rather than a loss: what the container actually did
    // is recorded in the action log, which is separate from the transcript and
    // is what other agents read to avoid redoing work. The transcript line is a
    // courtesy to whoever is watching.
    //
    // It also stops the container clearing chainDepth below. A person speaking
    // is what restarts every agent chain; a container reporting a clone is not,
    // and letting it reset the bound would put the count back within reach of
    // something an agent can cause.
    if (role === "workspace") {
      this.append({
        id: randomUUID(),
        kind: "system",
        authorHandle: member.handle,
        authorName: member.displayName,
        text,
        ts: Date.now(),
      });
      return;
    }

    // A person speaking restarts every chain. That is the whole shape of the
    // bound: agents may carry something a short way between two human messages,
    // and a human is what makes it a conversation again rather than a loop.
    this.chainDepth.clear();
    this.append({
      id: randomUUID(),
      kind: "human",
      authorHandle: member.handle,
      authorName: member.displayName,
      text,
      ts: Date.now(),
    });
    await this.driver.say(member, text);
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
    const executor = this.executorOf(handle);
    if (!executor) {
      // resolveTarget already rejects absent members; this is the race where
      // they disconnected in between. Fail fast rather than wait for the timeout.
      void this.driver.resolveToolCall(
        callId,
        `@${handle} disconnected before the tool could run.`,
        true
      );
      return;
    }
    this.sendTo(executor.socket, { t: "toolCall", callId, name, input });
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
    this.trim();
    this.broadcast({ t: "entry", entry });
    this.onChanged?.();
  }

  /**
   * Keep the transcript bounded, discarding join/leave noise before anything
   * anybody said.
   *
   * Trimming by position alone treats "Sam joined the room." as equal in value
   * to the message Sam wrote, and there are far more of the former: every
   * connection, every agent attach, every reconnect on a flaky link appends
   * one. The live demo room reached the cap at 500 of 500 entries, all of them
   * system, having evicted every real message in it — a room in use for two
   * days remembering nothing but its own doorbell.
   *
   * So system entries go first, oldest first, and real messages are only
   * touched when there is nothing else left to give. The memory bound is
   * unchanged; what it spends its budget on is not.
   */
  private trim(): void {
    let excess = this.transcript.length - Room.MAX_TRANSCRIPT;
    if (excess <= 0) return;

    for (let i = 0; i < this.transcript.length && excess > 0; ) {
      if (this.transcript[i].kind === "system") {
        this.transcript.splice(i, 1);
        excess--;
      } else {
        i++;
      }
    }
    // Still over, so the room is genuinely full of conversation. Oldest first.
    if (excess > 0) this.transcript.splice(0, excess);
  }

  private broadcastRoster(): void {
    this.broadcast({ t: "roster", roster: this.roster, workspaceHost: this.host });
    // Re-assert status so a joiner's UI is not stuck on a stale pill.
    this.broadcast({ t: "status", status: this.status, waitingOn: this.waitingOn });
  }

  /** Attached agents observe the room too — that is how they see what to answer. */
  private broadcast(msg: ServerMsg): void {
    for (const live of this.connections.values()) {
      for (const { socket } of live) this.sendTo(socket, msg);
    }
    for (const { socket } of this.agents.values()) this.sendTo(socket, msg);
  }

  /** Say something to every machine a member is at, or to nobody if they are gone. */
  private sendToHandle(handle: string, msg: ServerMsg): void {
    for (const { socket } of this.connections.get(handle) ?? []) this.sendTo(socket, msg);
  }

  /** Who a handle belongs to, from whichever of their connections answers first. */
  private memberOf(handle: string): Member | undefined {
    for (const conn of this.connections.get(handle) ?? []) return conn.member;
    return undefined;
  }

  /**
   * The one machine a member's *work* is dispatched to.
   *
   * Everything the relay tells a member goes to all of them, but running a tool
   * is not a notification: fanning a remote tool call out to both of somebody's
   * laptops would run the command twice and write the file twice, and then
   * throw one of the two answers away. Their oldest live connection is the one
   * that stays put — picking the newest would move execution onto whichever
   * machine they happened to open last, mid-conversation.
   */
  private executorOf(handle: string): Connection | undefined {
    for (const conn of this.connections.get(handle) ?? []) return conn;
    return undefined;
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

function validGoalRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_GOAL_REQUEST_ID_CHARS &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validContextRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CONTEXT_REQUEST_ID_CHARS &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function validContextKind(value: unknown): value is ContextKind {
  return (
    value === "decision" ||
    value === "fact" ||
    value === "constraint" ||
    value === "question" ||
    value === "reference" ||
    value === "note"
  );
}

function validContextTransition(from: ContextStatus, to: Exclude<ContextStatus, "proposed">): boolean {
  if (from === "proposed") return to === "accepted" || to === "superseded" || to === "archived";
  if (from === "accepted") return to === "superseded" || to === "archived";
  return false;
}

function normaliseContextText(
  value: unknown,
  max: number,
  allowEmpty = false
): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = redactHandoffText(value).trim();
  if ((!allowEmpty && text.length === 0) || text.length > max) return undefined;
  return text;
}

function normaliseContextTags(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_TAGS) return undefined;
  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return undefined;
    const tag = redactHandoffText(raw).trim();
    if (tag.length === 0 || tag.length > MAX_CONTEXT_TAG_CHARS) return undefined;
    if (!tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) tags.push(tag);
  }
  return tags;
}

function contextActorKey(actor: ContextMutationActor): string {
  return actor.role === "agent" && actor.agentId ? actor.agentId : actor.handle;
}

function contextRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contextRequestKey(actorKey: string, requestId: string): string {
  return `${actorKey}\0${requestId}`;
}

function validAgentActivity(value: unknown): value is AgentActivity {
  return (
    value === "idle" ||
    value === "thinking" ||
    value === "reading" ||
    value === "editing" ||
    value === "running" ||
    value === "responding" ||
    value === "awaiting-approval"
  );
}

/** A 1-based line anchor, or nothing. Zero and fractions are not locations. */
function presenceLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Two presence frames the room would render identically. */
function samePresence(a: AgentPresence, b: AgentPresence): boolean {
  return (
    a.phase === b.phase &&
    a.summary === b.summary &&
    a.path === b.path &&
    a.line === b.line &&
    a.endLine === b.endLine
  );
}

function boundedOptional(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = redactHandoffText(value).trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function validHandoffRequestId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_HANDOFF_REQUEST_ID_CHARS &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isHandoffTerminal(status: HandoffOffer["status"] | undefined): boolean {
  return Boolean(
    status &&
      ["completed", "failed", "outcomeUnknown", "declined", "cancelled", "expired"].includes(
        status
      )
  );
}

/** Persist a fixed-size retry identity even when a rejected payload was huge. */
function goalRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function goalRequestKey(actorHandle: string, requestId: string): string {
  return `${actorHandle}\0${requestId}`;
}

function handoffRequestFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function handoffRequestKey(actorHandle: string, requestId: string): string {
  return `${actorHandle}\0${requestId}`;
}

/** Receipts retain the mutation result, never an O(goals + audit) snapshot. */
function durableGoalResult(result: GoalResultMsg): GoalResultMsg {
  const durable: GoalResultMsg = {
    t: "goalResult",
    requestId: result.requestId,
    ok: result.ok,
    roomRevision: result.roomRevision,
  };
  if (result.goal) durable.goal = { ...result.goal };
  if (result.message !== undefined) durable.message = result.message;
  return durable;
}

/** Receipts retain one result, never the full context and audit snapshot. */
function durableContextResult(result: ContextResultMsg): ContextResultMsg {
  const durable: ContextResultMsg = {
    t: "contextResult",
    requestId: result.requestId,
    ok: result.ok,
    contextRevision: result.contextRevision,
  };
  if (result.item) durable.item = structuredClone(result.item);
  if (result.message !== undefined) durable.message = result.message;
  return durable;
}

/** Receipts retain one result, never an O(handoffs + audit) snapshot. */
function durableHandoffResult(result: HandoffResultMsg): HandoffResultMsg {
  const durable: HandoffResultMsg = {
    t: "handoffResult",
    requestId: result.requestId,
    ok: result.ok,
    handoffRevision: result.handoffRevision,
  };
  if (result.handoff) durable.handoff = structuredClone(result.handoff);
  if (result.message !== undefined) durable.message = result.message;
  return durable;
}

/** Redact common credentials before shared text becomes continuation context. */
export function redactHandoffText(value: string): string {
  return value
    .replace(/\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}\b/gi, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|room[_-]?token|secret|password)\s*[:=]\s*)["']?[^\s"',;]+/gi,
      "$1[REDACTED]"
    );
}

function nextGoalStatus(status: Goal["status"], action: GoalTransition): Goal["status"] | undefined {
  if (status === "active" && action === "pause") return "paused";
  if (status === "paused" && action === "resume") return "active";
  if ((status === "active" || status === "paused") && action === "complete") {
    return "completed";
  }
  return undefined;
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
