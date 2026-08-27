/**
 * WebSocket server and room registry.
 *
 * Owns the Anthropic API key; no editor client ever sees it. Each room code
 * maps to one shared agent session.
 */

import { createServer } from "node:http";
import { isIP } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ConnectionRole, Member, ServerMsg } from "@ripieno/protocol";
import { WORKSPACE_HANDLE } from "@ripieno/protocol";
import { ByoDriver } from "./byoDriver.js";
import { Room } from "./room.js";
import { createRoomStore } from "./roomStore.js";
import { GithubVerifier } from "./identity.js";
import { publicUrlFromHeaders } from "./bootstrap.js";

/**
 * How often to ping clients, and therefore how long a vanished member can look
 * present. A member whose process is killed or whose laptop sleeps never sends
 * a close frame, so without this they stay in the roster indefinitely — and the
 * agent keeps addressing workspace tools to a machine that is not there.
 */
/** Largest frame accepted. Generous for a tool result, absurd for a message. */
const MAX_FRAME_BYTES = 1 << 20;
const HEARTBEAT_MS = 15_000;

export type RelayMode = "hosted" | "byo";

export interface ServerConfig {
  port: number;
  mode: RelayMode;
  /** Loopback binds are private by default; a deployed relay must be explicit. */
  host?: string;
  /**
   * Shared secret required on join. Absent means the relay is open — fine on
   * localhost, never acceptable on a public URL.
   */
  token?: string;
  /**
   * Secret held only by the shared-workspace container.
   *
   * Separate from the room token on purpose. Everyone in the room holds that
   * one, and a connection claiming the workspace handle is trusted to say what
   * every file in the repo contains — so with a single shared secret, any member
   * could impersonate the workspace and quietly feed every agent in the room a
   * different codebase than the real one.
   */
  workspaceToken?: string;
  /**
   * Refuse joins that cannot prove who they are.
   *
   * Off by default so an existing deployment and local two-window testing keep
   * working; turning it on is what makes roles and attribution mean anything.
   */
  requireGithub?: boolean;
  /**
   * Refuse connections that carry an `Origin` header.
   *
   * Loopback is not a boundary against a web page. Browsers do not apply CORS
   * to WebSockets, so any site can open a socket to 127.0.0.1 and walk the
   * ephemeral port range until something answers — and a solo relay answers
   * with no token, because demanding one from somebody talking to their own
   * editor would be ceremony rather than security.
   *
   * A browser always sends `Origin`; the `ws` client the extension uses never
   * does. That asymmetry is the whole check, and it is why this is safe to turn
   * on for the tokenless case and wrong to turn on generally.
   */
  denyBrowserOrigins?: boolean;
  /** Injectable so tests can stand in for GitHub. Production builds its own. */
  verifier?: GithubVerifier;
  /** Where room history is kept. Undefined means rooms vanish on restart. */
  dataDir?: string;
  /** Required in hosted mode only; BYO needs no Anthropic resources at all. */
  agentId?: string;
  environmentId?: string;
  /**
   * Called once, with the address this relay turned out to be reachable on.
   *
   * A relay behind a proxy cannot see its own public name, but every request
   * carries it. Reporting rather than returning it because the answer does not
   * exist yet when the server starts — it arrives with the first caller.
   */
  onPublicUrl?: (url: string) => void;
}

/**
 * A relay, plus a way to make sure its history is on disk before the process
 * goes. `wss.close()` cannot do that on its own: its callback fires in the same
 * turn as the close listeners, so a flush started there never gets to await a
 * single write.
 */
export type Relay = WebSocketServer & {
  flush(): Promise<void>;
  /**
   * The port actually bound, once listening.
   *
   * Needed because a relay can be started on port 0 — "anything free" — which is
   * what the extension does when it runs one in-process for solo use, so that
   * two windows on one machine do not collide.
   */
  whenListening(): Promise<number>;
};

/**
 * Should this relay verify who members are, rather than believing the handle
 * they send?
 *
 * On by default for any relay another machine can reach; off for one bound to
 * loopback. This product's whole claim is that authorship is structure the
 * relay maintains rather than something a client asserts — and it shipped with
 * verification off, so what a stranger ran out of the box was the version where
 * everybody simply says who they are, with the attribution in the README
 * describing a mode they had not enabled. A default that contradicts the
 * headline is worse than not making the claim.
 *
 * Loopback is exempt because there is nobody else on it. Solo mode talks to a
 * relay on the same machine, and demanding a GitHub sign-in to speak to your own
 * laptop is ceremony rather than security — it would also ruin the one-minute
 * path that is most people's first impression of the product.
 *
 * An explicit `0` or empty string turns it off, for an existing deployment or a
 * private network where the token is already the boundary. Requiring somebody to
 * say so out loud is the point: it should be a decision rather than a default.
 */
export function resolveRequireGithub(raw: string | undefined, host: string | undefined): boolean {
  if (raw !== undefined) return raw !== "0" && raw !== "" && raw.toLowerCase() !== "false";
  return !isLoopbackHost(host);
}

/** Node otherwise treats an omitted host as all interfaces, which is unsafe here. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return true;
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

/** Default locally to loopback; hosting platforms that inject PORT are explicit deployments. */
export function resolveRelayHost(raw: string | undefined, deployed: boolean): string {
  const configured = raw?.trim();
  return configured || (deployed ? "0.0.0.0" : "127.0.0.1");
}

/** Refuse every externally reachable bind without a room gate, not only Railway's PORT shape. */
export function validateRelayExposure(host: string | undefined, token: string | undefined): string | undefined {
  if (isLoopbackHost(host) || token?.trim()) return undefined;
  return "Refusing to start: a relay reachable outside this machine requires RIPIENO_TOKEN.";
}

/**
 * A standalone process may bind to loopback and still sit behind a public
 * reverse proxy or tunnel. Unlike the extension's in-process solo relay, it
 * therefore always needs an explicit shared gate.
 */
export function validateStandaloneRelayExposure(token: string | undefined): string | undefined {
  if (token?.trim()) return undefined;
  return "A standalone Ripieno relay requires RIPIENO_TOKEN, including when it binds to loopback.";
}

/** The standalone relay verifies identity unless the operator explicitly opts out. */
export function resolveStandaloneRequireGithub(raw: string | undefined): boolean {
  return resolveRequireGithub(raw, "0.0.0.0");
}

export function startServer(config: ServerConfig): Relay {
  const bindHost = config.host ?? "127.0.0.1";
  const exposureError = validateRelayExposure(bindHost, config.token);
  if (exposureError) throw new Error(exposureError);
  const rooms = new Map<string, Room>();
  const store = createRoomStore(config.dataDir);
  const verifier = config.verifier ?? new GithubVerifier();
  /** Pending saves, so a busy room writes once rather than once per message. */
  const saveTimers = new Map<string, NodeJS.Timeout>();

  /**
   * Persist shortly after a change rather than on every message.
   *
   * A room in full flow would otherwise write on every keystroke-sized event;
   * a second's delay costs at most a second of history against a hard kill, and
   * a clean shutdown flushes anyway.
   */
  function scheduleSave(code: string, room: Room): void {
    if (saveTimers.has(code)) return;
    const timer = setTimeout(() => {
      saveTimers.delete(code);
      void store.save(code, room.snapshot()).catch((err) => {
        log(`could not save room ${code}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, 1000);
    timer.unref();
    saveTimers.set(code, timer);
  }

  async function flushSaves(): Promise<void> {
    for (const [code, timer] of saveTimers) {
      clearTimeout(timer);
      const room = rooms.get(code);
      if (room) await store.save(code, room.snapshot()).catch(() => undefined);
    }
    saveTimers.clear();
  }
  /** In-flight creations, so two simultaneous joins do not build two sessions. */
  const starting = new Map<string, Promise<Room>>();
  // An HTTP server the WebSocket server rides on, rather than ws binding the
  // port itself. A deployed relay needs a plain-HTTP surface: it is how a host's
  // healthcheck decides the service is alive, and how a human checks a deploy
  // without opening a WebSocket client. It deliberately reveals nothing about
  // rooms or members — an unauthenticated caller learns only that this is a
  // relay and whether it wants a token.
  /** Fired once. A later request cannot teach us anything the first did not. */
  let publicUrlReported = false;
  function notePublicUrl(headers: Record<string, string | string[] | undefined>): void {
    if (publicUrlReported || !config.onPublicUrl) return;
    const url = publicUrlFromHeaders(headers);
    if (!url) return;
    publicUrlReported = true;
    config.onPublicUrl(url);
  }

  const http = createServer((req, res) => {
    notePublicUrl(req.headers);
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "ripieno-relay",
          status: "ok",
          mode: config.mode,
          tokenRequired: Boolean(config.token),
          // So a client only asks somebody to sign in where the answer is
          // actually checked. A prompt on a relay that never verifies buys
          // attribution by convention and costs a barrier before anything has
          // happened.
          identityRequired: Boolean(config.requireGithub),
        })
      );
      return;
    }
    res.writeHead(404).end();
  });

  /**
   * A frame nobody has any business sending.
   *
   * `ws` defaults to 100MB, and a room's transcript is held in memory and
   * broadcast to every member and agent — so one token-holder could push 100MB
   * into everyone's process. The persisted copy was carefully capped at 1MB;
   * the concern was handled on the disk path and missed on the wire.
   */
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_FRAME_BYTES,
    ...(config.denyBrowserOrigins
      ? {
          verifyClient: ({ origin }: { origin?: string }) => {
            if (origin === undefined) return true;
            log(`refused a browser connection from ${origin}`);
            return false;
          },
        }
      : {}),
  });
  // Garbage that never becomes a WebSocket at all — a malformed request line,
  // oversized headers, a connection cut mid-handshake. Node's default is to
  // destroy the socket, but only once something is listening; otherwise this
  // throws too.
  http.on("clientError", (err: Error, socket: { destroy: () => void }) => {
    log(`client error: ${err.message}`);
    socket.destroy();
  });
  // A listen failure — port taken, address unavailable — should be a message,
  // not a stack trace with the port buried in it.
  http.on("error", (err: Error) => {
    log(`listen error: ${err.message}`);
  });
  http.listen(config.port, bindHost);

  function roomFor(code: string): Promise<Room> {
    const existing = rooms.get(code);
    if (existing) return Promise.resolve(existing);
    const inFlight = starting.get(code);
    if (inFlight) return inFlight;

    // Only cache once start() has succeeded. Caching first means one transient
    // failure (a 529 on session create) leaves a permanently broken room behind:
    // later joiners get a normal-looking room whose messages reach nobody.
    const attempt = createRoom(code)
      .then((room) => {
        rooms.set(code, room);
        return room;
      })
      .finally(() => {
        starting.delete(code);
      });
    starting.set(code, attempt);
    return attempt;
  }

  async function createRoom(code: string): Promise<Room> {
    if (config.mode === "byo") {
      const room = new Room(code, new ByoDriver(), "byo");
      await restore(code, room);
      log(`room ${code} ready (byo — members attach their own agents)`);
      return room;
    }

    // Hosted mode is not shipped.
    //
    // It was built against the driver interface above, compiles, and its unit
    // tests pass — but it has never run against a live Managed Agents session,
    // so shipping it as one of two headline modes would be describing something
    // unrun. The seam it was built against is right here, which is the part
    // worth keeping either way.
    throw new Error(
      "hosted mode is not available in this build. " +
        "Unset RIPIENO_MODE to run in BYO mode, which is what this relay is for."
    );
  }

  /** Bring back whatever this room had before the last restart. */
  async function restore(code: string, room: Room): Promise<void> {
    room.onChanged = () => scheduleSave(code, room);
    room.onCriticalChanged = () => store.save(code, room.snapshot());
    const snapshot = await store.load(code);
    if (!snapshot) return;
    const recoveredUncertainHandoff = room.hydrate(snapshot);
    if (recoveredUncertainHandoff) await room.onCriticalChanged();
    log(`room ${code} restored — ${snapshot.transcript.length} messages, ${snapshot.actions.length} actions`);
  }

  /** Drop an empty room so its session, stream and timers do not leak. */
  async function reap(code: string, room: Room): Promise<void> {
    if (!room.isEmpty || rooms.get(code) !== room) return;
    rooms.delete(code);
    // Save before dropping it from memory: an emptied room is exactly the one
    // whose history someone will want when they come back.
    const pending = saveTimers.get(code);
    if (pending) clearTimeout(pending);
    saveTimers.delete(code);
    await store.save(code, room.snapshot()).catch(() => undefined);
    await room.dispose();
    log(`room ${code} closed (empty)`);
  }

  // Liveness. A socket that misses a round trip is presumed gone and terminated,
  // which runs the ordinary close path — leave, then reap.
  const alive = new WeakSet<WebSocket>();
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!alive.has(socket)) {
        socket.terminate();
        continue;
      }
      alive.delete(socket);
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  // Not covered by the per-socket handler above: a failed upgrade has no socket
  // to attribute the error to, and unhandled here it is equally fatal.
  wss.on("error", (err: Error) => {
    log(`relay error: ${err.message}`);
  });

  wss.on("close", () => {
    clearInterval(heartbeat);
    http.close();
    // Best effort for callers that never call flush(); the reliable path is
    // awaiting relay.flush() before exiting.
    void flushSaves();
  });

  wss.on("connection", (socket: WebSocket, request?: { headers?: Record<string, string | string[] | undefined> }) => {
    // A real client upgrade is the most trustworthy sample of all: unlike a
    // platform healthcheck, it arrived at the address somebody was actually given.
    if (request?.headers) notePublicUrl(request.headers);
    alive.add(socket);
    // Node rethrows an 'error' event that nobody is listening for, and `ws`
    // emits one for any frame it cannot parse — a bad opcode, a reserved close
    // code, a broken mask. That is a stranger's two bytes deciding whether this
    // process lives, before a token is ever looked at, and it takes every other
    // room down with it. One misbehaving peer is that peer's problem only.
    socket.on("error", (err: Error) => {
      log(`socket error: ${err.message}`);
      alive.delete(socket);
      socket.terminate();
    });
    socket.on("pong", () => alive.add(socket));
    let joined:
      | { room: Room; handle: string; role: ConnectionRole; agentId?: string; label: string }
      | undefined;

    // Frames are handled strictly in order. Without this, `joined` is still
    // undefined while `join` awaits, so anything sent in the same tick — the
    // client's flushed offline queue, including tool results — is silently
    // dropped by the `if (joined)` guards below.
    let queue: Promise<void> = Promise.resolve();

    socket.on("message", (raw) => {
      queue = queue.then(() => handle(raw)).catch((err) => {
        log(`unhandled: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    async function handle(raw: unknown): Promise<void> {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw)) as ClientMsg;
      } catch {
        return send(socket, "malformed message");
      }

      try {
        if (
          msg.t !== "join" &&
          joined?.role === "agent" &&
          joined.agentId &&
          !joined.room.isAgentAuthorized(joined.agentId, socket)
        ) {
          return send(socket, "this agent is no longer authorised in the room");
        }
        switch (msg.t) {
          case "join": {
            if (joined) return send(socket, "already joined on this connection");
            // Checked before anything else touches room state, so an unauthorised
            // client cannot create rooms or learn who is in them.
            if (config.token && msg.token !== config.token) {
              send(socket, "invalid or missing room token");
              socket.close(4003, "unauthorised");
              return;
            }
            const member = sanitise(msg.member);
            if (!member) return send(socket, "invalid member identity");

            // Identity before anything else touches room state. The handle is
            // taken from GitHub's answer, never from what the client sent.
            if (config.requireGithub && msg.role !== "workspace") {
              const verified = await verifier.verify(msg.githubToken);
              if (!verified.ok) {
                send(socket, `identity refused: ${verified.reason}`);
                socket.close(4003, "unverified identity");
                return;
              }
              member.handle = verified.identity.handle;
              member.displayName = verified.identity.displayName;
              if (verified.identity.avatarUrl) member.avatarUrl = verified.identity.avatarUrl;
            }

            const wantsWorkspace = msg.role === "workspace";
            if (wantsWorkspace) {
              if (!config.workspaceToken || msg.workspaceToken !== config.workspaceToken) {
                send(socket, "invalid or missing workspace token");
                socket.close(4003, "unauthorised");
                return;
              }
              // Never taken from the client: the handle *is* the trust claim.
              member.handle = WORKSPACE_HANDLE;
              member.displayName = "Shared workspace";
            } else if (member.handle === WORKSPACE_HANDLE) {
              // Reserved. Without this any member could join under it and serve
              // fabricated file contents to every agent in the room.
              send(socket, `"${WORKSPACE_HANDLE}" is a reserved handle`);
              socket.close(4003, "reserved handle");
              return;
            }

            const role: ConnectionRole = wantsWorkspace
              ? "workspace"
              : msg.role === "agent"
                ? "agent"
                : "human";
            const room = await roomFor(msg.room.trim());
            // Several agents may belong to one person, so each carries its own
            // id. Defaulting keeps single-agent clients working unchanged.
            const agent =
              role === "agent"
                ? {
                    // Namespaced by owner, and never taken raw from the client.
                    // Two members whose clients both default to the same id
                    // would otherwise evict each other forever: each join closes
                    // the other's socket, which reconnects and closes back.
                    id: `${member.handle}::${sanitiseId(msg.agentId) ?? "default"}`,
                    label:
                      typeof msg.agentLabel === "string" && msg.agentLabel.trim() !== ""
                        ? msg.agentLabel.slice(0, 60)
                        : `${member.displayName}'s agent`,
                    capability: msg.agentCapability === "workspace" ? ("workspace" as const) : ("conversation" as const),
                  }
                : undefined;
            // A viewer may watch, but an agent acts — and acting is what they
            // are not allowed to do. Refused at the connection rather than at
            // each message, so nothing spawns and then discovers it is mute.
            if (role === "agent" && !room.canAct(member.handle)) {
              send(socket, "viewers cannot attach agents to this room");
              socket.close(4003, "viewer");
              return;
            }
            await room.join(member, socket, role, agent);
            if (role === "agent" && agent && !room.isAgentAuthorized(agent.id, socket)) return;
            joined = {
              room,
              handle: member.handle,
              role,
              agentId: agent?.id,
              label: agent?.label ?? member.displayName,
            };
            break;
          }
          case "say":
            if (!joined) return send(socket, "join a room before sending messages");
            if (!joined.room.canAct(joined.handle)) {
              return send(socket, "viewers can read this room but not post to it");
            }
            await joined.room.say(joined.handle, msg.text, joined.role, joined.agentId);
            break;
          case "toolProgress":
            if (!joined) return send(socket, "join a room before reporting tool progress");
            // Progress extends the deadline on a call, so it must come from the
            // connection executing it — not from an agent, which cannot be
            // running anything on anyone's disk.
            if (joined.role === "agent") {
              return send(socket, "an agent does not execute tool calls");
            }
            joined.room.toolProgress(joined.handle, msg.callId, msg.state);
            break;
          case "toolResult":
            if (!joined) return send(socket, "join a room before returning tool results");
            if (joined.role === "agent") return send(socket, "an agent cannot return tool results");
            await joined.room.toolResult(
              joined.handle,
              msg.callId,
              msg.content,
              msg.isError === true
            );
            break;
          case "agentUsage":
            if (!joined?.agentId) return;
            joined.room.recordUsage(joined.agentId, msg.provider, msg.usage);
            break;

          case "agentState":
            // Only an agent connection has a state to report, and it reports
            // its own — the id comes from the socket, not from the message.
            if (!joined?.agentId) return;
            joined.room.setAgentState(joined.agentId, msg.state);
            break;

          case "agentActivity":
            // Rich presence is ephemeral and self-authored. The socket, never
            // the payload, chooses which agent appears to be active.
            if (!joined?.agentId || joined.role !== "agent") return;
            joined.room.setAgentActivity(
              joined.agentId,
              msg.phase,
              msg.summary,
              msg.path,
              msg.line,
              msg.endLine,
              msg.sequence,
              msg.locationScope
            );
            break;

          case "agentDraft":
            // User-facing draft text is attributed exactly like presence: the
            // authenticated socket chooses the agent, never a payload field.
            if (!joined?.agentId || joined.role !== "agent") return;
            joined.room.publishAgentDraft(joined.agentId, msg.delta, msg.sequence);
            break;

          case "agentDraftCancel":
            if (!joined?.agentId || joined.role !== "agent") return;
            joined.room.cancelAgentDraftById(joined.agentId);
            break;

          case "setRole":
            if (!joined) return send(socket, "join a room before changing roles");
            if (joined.role !== "human") {
              return send(socket, "only a human room owner may change roles");
            }
            await joined.room.setRole(joined.handle, msg.handle, msg.role);
            break;

          case "claimWorkspace":
            if (!joined) return send(socket, "join a room before claiming the workspace");
            if (joined.role === "agent") return send(socket, "only a member may host a workspace");
            joined.room.claimWorkspace(joined.handle, msg.claim);
            break;

          case "workspaceChanged":
            if (!joined) return;
            joined.room.noteWorkspaceChanged(joined.handle, msg.paths);
            break;

          case "goalCreate":
            if (!joined) return send(socket, "join a room before creating a goal");
            if (joined.role !== "human") {
              return send(socket, "only a human member may create a goal");
            }
            sendMessage(
              socket,
              joined.room.createGoal(joined.handle, msg.requestId, msg.text)
            );
            break;

          case "goalTransition":
            if (!joined) return send(socket, "join a room before changing a goal");
            if (joined.role !== "human") {
              return send(socket, "only a human member may change a goal");
            }
            sendMessage(
              socket,
              joined.room.transitionGoal(
                joined.handle,
                msg.requestId,
                msg.goalId,
                msg.action,
                msg.expectedVersion
              )
            );
            break;

          case "contextCreate":
            if (!joined) return send(socket, "join a room before adding context");
            if (joined.role === "workspace") {
              return send(socket, "the shared workspace cannot author room context");
            }
            sendMessage(
              socket,
              joined.room.createContext(
                {
                  handle: joined.handle,
                  role: joined.role,
                  agentId: joined.agentId,
                  agentLabel: joined.role === "agent" ? joined.label : undefined,
                },
                msg.requestId,
                msg.kind,
                msg.title,
                msg.body,
                msg.tags
              )
            );
            break;

          case "contextUpdate":
            if (!joined) return send(socket, "join a room before changing context");
            if (joined.role === "workspace") {
              return send(socket, "the shared workspace cannot change room context");
            }
            sendMessage(
              socket,
              joined.room.updateContext(
                {
                  handle: joined.handle,
                  role: joined.role,
                  agentId: joined.agentId,
                  agentLabel: joined.role === "agent" ? joined.label : undefined,
                },
                msg.requestId,
                msg.contextId,
                msg.expectedVersion,
                { title: msg.title, body: msg.body, tags: msg.tags, status: msg.status }
              )
            );
            break;

          case "handoffOffer":
            if (!joined) return send(socket, "join a room before offering a handoff");
            if (joined.role !== "human") {
              return send(socket, "only a human member may offer a handoff");
            }
            sendMessage(
              socket,
              joined.room.createHandoff(
                joined.handle,
                msg.requestId,
                msg.targetHandle,
                msg.sourceAgentId,
                msg.task
              )
            );
            break;

          case "handoffDecision":
            if (!joined) return send(socket, "join a room before deciding a handoff");
            if (joined.role !== "human") {
              return send(socket, "only a human member may decide a handoff");
            }
            if (
              msg.action !== "accept" &&
              msg.action !== "decline" &&
              msg.action !== "cancel" &&
              msg.action !== "retry"
            ) {
              return send(socket, "unknown handoff decision");
            }
            sendMessage(
              socket,
              await joined.room.decideHandoff(
                joined.handle,
                msg.requestId,
                msg.handoffId,
                msg.nonce,
                msg.action,
                msg.expectedVersion,
                msg.targetAgentId
              )
            );
            break;

          case "handoffClaim":
            if (!joined?.agentId || joined.role !== "agent") {
              return send(socket, "only the selected recipient agent may claim a handoff");
            }
            if (
              !(await joined.room.claimHandoff(
                joined.agentId,
                msg.handoffId,
                msg.deliveryId,
                msg.expectedVersion
              ))
            ) return send(socket, "handoff claim rejected by authoritative room state");
            break;

          case "handoffStarted":
            if (!joined?.agentId || joined.role !== "agent") {
              return send(socket, "only the selected recipient agent may start a handoff");
            }
            if (
              !(await joined.room.markHandoffStarted(
                joined.agentId,
                msg.handoffId,
                msg.deliveryId,
                msg.expectedVersion
              ))
            ) return send(socket, "handoff start rejected by authoritative room state");
            break;

          case "handoffOutcome":
            if (!joined?.agentId || joined.role !== "agent") {
              return send(socket, "only the selected recipient agent may report a handoff outcome");
            }
            if (
              msg.outcome !== "completed" &&
              msg.outcome !== "failed" &&
              msg.outcome !== "outcomeUnknown"
            ) return send(socket, "invalid handoff outcome");
            if (
              !(await joined.room.reportHandoffOutcome(
                joined.agentId,
                msg.handoffId,
                msg.deliveryId,
                msg.outcome,
                msg.detail
              ))
            ) return send(socket, "handoff outcome rejected by authoritative room state");
            break;

          case "remoteTool": {
            if (!joined) return send(socket, "join a room before using another workspace");
            if (joined.role !== "agent" || !joined.agentId) {
              return send(socket, "only an agent may act on another member's workspace");
            }
            joined.room.routeRemoteTool(
              { agentId: joined.agentId, label: joined.label, handle: joined.handle },
              msg.requestId,
              msg.targetHandle,
              msg.name,
              msg.input
            );
            break;
          }

          case "remoteToolResult":
            if (!joined) return;
            if (joined.role === "agent") {
              return send(socket, "an agent cannot answer remote workspace calls");
            }
            joined.room.completeRemoteTool(
              joined.handle,
              msg.requestId,
              msg.content,
              msg.isError === true
            );
            break;

          case "ping":
            break;
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`error handling ${msg.t}: ${detail}`);
        send(socket, detail);
      }
    }

    socket.on("close", () => {
      const was = joined;
      if (!was) return;
      // Pass the socket: a reconnect installs its replacement before this fires,
      // and evicting by handle alone would delete the live connection.
      queue = queue
        .then(() => was.room.leave(was.handle, was.role, socket, was.agentId))
        .then(() => reap(was.room.code, was.room))
        .catch(() => undefined);
    });
  });

  log(
    `relay listening on ${bindHost}:${config.port} ` +
      `(${config.mode} mode, ${config.token ? "token required" : "OPEN — no token"}, ` +
      `${config.dataDir ? `history in ${config.dataDir}` : "history in memory only"})`
  );
  if (!config.token && !isLoopbackHost(bindHost)) {
    log("  warning: no RIPIENO_TOKEN set. Anyone who can reach this port can join any room.");
  }
  const relay = wss as Relay;
  relay.flush = flushSaves;
  relay.whenListening = () =>
    new Promise<number>((resolve, reject) => {
      const settle = (): void => {
        const address = http.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("the relay is listening without a port"));
      };
      if (http.listening) settle();
      else {
        http.once("listening", settle);
        http.once("error", reject);
      }
    });
  return relay;
}

/** Agent ids come from clients too, and end up as map keys. Keep them tame. */
function sanitiseId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const id = raw.trim();
  return /^[A-Za-z0-9._:-]{1,80}$/.test(id) ? id : undefined;
}

/** A client-supplied identity is untrusted input; keep it to a sane shape. */
function sanitise(member: Member | undefined): Member | undefined {
  if (!member || typeof member.handle !== "string" || typeof member.displayName !== "string") {
    return undefined;
  }
  const handle = member.handle.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9-_]{1,39}$/.test(handle)) return undefined;
  return {
    handle,
    displayName: member.displayName.slice(0, 80) || handle,
    avatarUrl: typeof member.avatarUrl === "string" ? member.avatarUrl : undefined,
    repo: typeof member.repo === "string" ? member.repo.slice(0, 120) : undefined,
  };
}

function send(socket: WebSocket, message: string): void {
  sendMessage(socket, { t: "error", message });
}

function sendMessage(socket: WebSocket, message: ServerMsg): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function log(...parts: string[]): void {
  console.log(`[relay] ${parts.join(" ")}`);
}
