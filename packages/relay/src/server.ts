/**
 * WebSocket server and room registry.
 *
 * Owns the Anthropic API key; no editor client ever sees it. Each room code
 * maps to one shared agent session.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ConnectionRole, Member } from "@mpa/protocol";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import { ByoDriver } from "./byoDriver.js";
import { HostedDriver } from "./hostedDriver.js";
import { Room } from "./room.js";
import { createRoomStore } from "./roomStore.js";
import { GithubVerifier } from "./identity.js";

/**
 * How often to ping clients, and therefore how long a vanished member can look
 * present. A member whose process is killed or whose laptop sleeps never sends
 * a close frame, so without this they stay in the roster indefinitely — and the
 * agent keeps addressing workspace tools to a machine that is not there.
 */
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
  /** Injectable so tests can stand in for GitHub. Production builds its own. */
  verifier?: GithubVerifier;
  /** Where room history is kept. Undefined means rooms vanish on restart. */
  dataDir?: string;
  /** Required in hosted mode only; BYO needs no Anthropic resources at all. */
  agentId?: string;
  environmentId?: string;
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

export function startServer(config: ServerConfig): Relay {
  /**
   * Built on first use, and only in hosted mode.
   *
   * A static import would pull the whole SDK into anything that bundles this —
   * and the extension now does, to run a relay in-process for solo use. BYO mode
   * never touches it, so loading it eagerly was several megabytes spent on a
   * code path most deployments never reach.
   *
   * Credentials resolve from the environment (ANTHROPIC_API_KEY, or an
   * `ant auth login` profile) — never hardcoded, never accepted from a client.
   */
  let client: Anthropic | undefined;
  async function anthropic(): Promise<Anthropic> {
    if (client) return client;
    const { default: Ctor } = await import("@anthropic-ai/sdk");
    // The cast bridges dual-package type identities: the static import resolves
    // the CommonJS declaration and the dynamic one the ESM declaration, which
    // differ only by a private field. Same class either way.
    const made = new Ctor() as unknown as Anthropic;
    client = made;
    return made;
  }
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
    if (!config.dataDir || saveTimers.has(code)) return;
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
  const http = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          service: "multiplayer-agent-relay",
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

  const wss = new WebSocketServer({ server: http });
  http.listen(config.port, config.host);

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

    // Bound the forward reference so the driver's callbacks can reach the room
    // it is about to be handed to.
    let room: Room;
    const driver = new HostedDriver(
      await anthropic(),
      { agentId: config.agentId!, environmentId: config.environmentId!, roomCode: code },
      {
        onAgentMessage: (id, text) => room.onAgentMessage(id, text),
        onAgentDelta: (id, text) => room.onAgentDelta(id, text),
        onAgentDeltaCancel: (id) => room.onAgentDeltaCancel(id),
        onToolCall: (handle, callId, name, input) => room.onToolCall(handle, callId, name, input),
        onStatus: (status, waitingOn) => room.onStatus(status, waitingOn),
        onUsage: (usage) => log(`room ${code} usage`, JSON.stringify(usage)),
        onError: (message) => room.onError(message),
      }
    );
    room = new Room(code, driver, "hosted");
    await restore(code, room);
    await driver.start(room.roster);
    log(`room ${code} session ${driver.id}`);
    if (driver.traceUrl) log(`  trace: ${driver.traceUrl}`);
    return room;
  }

  /** Bring back whatever this room had before the last restart. */
  async function restore(code: string, room: Room): Promise<void> {
    room.onChanged = () => scheduleSave(code, room);
    const snapshot = await store.load(code);
    if (!snapshot) return;
    room.hydrate(snapshot);
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
    if (config.dataDir) await store.save(code, room.snapshot()).catch(() => undefined);
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
  wss.on("close", () => {
    clearInterval(heartbeat);
    http.close();
    // Best effort for callers that never call flush(); the reliable path is
    // awaiting relay.flush() before exiting.
    void flushSaves();
  });

  wss.on("connection", (socket: WebSocket) => {
    alive.add(socket);
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

          case "setRole":
            if (!joined) return send(socket, "join a room before changing roles");
            joined.room.setRole(joined.handle, msg.handle, msg.role);
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
    `relay listening on ${config.host ?? "0.0.0.0"}:${config.port} ` +
      `(${config.mode} mode, ${config.token ? "token required" : "OPEN — no token"}, ` +
      `${config.dataDir ? `history in ${config.dataDir}` : "history in memory only"})`
  );
  if (!config.token && config.host !== "127.0.0.1") {
    log("  warning: no MPA_TOKEN set. Anyone who can reach this port can join any room.");
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
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify({ t: "error", message }));
  }
}

function log(...parts: string[]): void {
  console.log(`[relay] ${parts.join(" ")}`);
}
