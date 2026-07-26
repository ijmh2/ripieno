/**
 * WebSocket server and room registry.
 *
 * Owns the Anthropic API key; no editor client ever sees it. Each room code
 * maps to one shared agent session.
 */

import Anthropic from "@anthropic-ai/sdk";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ClientMsg, ConnectionRole, Member } from "@mpa/protocol";
import { ByoDriver } from "./byoDriver.js";
import { HostedDriver } from "./hostedDriver.js";
import { Room } from "./room.js";

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
  /** Required in hosted mode only; BYO needs no Anthropic resources at all. */
  agentId?: string;
  environmentId?: string;
}

export function startServer(config: ServerConfig): WebSocketServer {
  // Only constructed in hosted mode, so BYO never needs a credential. Where it
  // is used, credentials resolve from the environment (ANTHROPIC_API_KEY, or an
  // `ant auth login` profile) — never hardcoded, never accepted from a client.
  const client = config.mode === "hosted" ? new Anthropic() : undefined;
  const rooms = new Map<string, Room>();
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
      log(`room ${code} ready (byo — members attach their own agents)`);
      return new Room(code, new ByoDriver(), "byo");
    }

    // Bound the forward reference so the driver's callbacks can reach the room
    // it is about to be handed to.
    let room: Room;
    const driver = new HostedDriver(
      client!,
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
    await driver.start(room.roster);
    log(`room ${code} session ${driver.id}`);
    if (driver.traceUrl) log(`  trace: ${driver.traceUrl}`);
    return room;
  }

  /** Drop an empty room so its session, stream and timers do not leak. */
  async function reap(code: string, room: Room): Promise<void> {
    if (!room.isEmpty || rooms.get(code) !== room) return;
    rooms.delete(code);
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
  });

  wss.on("connection", (socket: WebSocket) => {
    alive.add(socket);
    socket.on("pong", () => alive.add(socket));
    let joined:
      | { room: Room; handle: string; role: ConnectionRole; agentId?: string }
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
            const role: ConnectionRole = msg.role === "agent" ? "agent" : "human";
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
            await room.join(member, socket, role, agent);
            joined = { room, handle: member.handle, role, agentId: agent?.id };
            break;
          }
          case "say":
            if (!joined) return send(socket, "join a room before sending messages");
            await joined.room.say(joined.handle, msg.text, joined.role, joined.agentId);
            break;
          case "toolProgress":
            if (!joined) return send(socket, "join a room before reporting tool progress");
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
      `(${config.mode} mode, ${config.token ? "token required" : "OPEN — no token"})`
  );
  if (!config.token && config.host !== "127.0.0.1") {
    log("  warning: no MPA_TOKEN set. Anyone who can reach this port can join any room.");
  }
  return wss;
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
