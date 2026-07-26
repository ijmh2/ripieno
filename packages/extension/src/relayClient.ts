// WebSocket connection to the relay. The extension host is plain Node, so we
// use the `ws` package rather than a browser WebSocket global. This class
// hides reconnect/backoff/queueing from callers: `send` always "works" and
// the UI just renders whatever `getState()` says.

import WebSocket = require("ws");
import type { ClientMsg, ConnectionRole, JoinMsg, Member, ServerMsg } from "@mpa/protocol";

export type ConnectionState = "connecting" | "online" | "offline";

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
/** Relay close codes that must not be retried. */
const EVICTED_CODE = 4000;
const UNAUTHORISED_CODE = 4003;

export interface RelayClientOptions {
  url: string;
  room: string;
  member: Member;
  /**
   * "agent" attaches a member's own local agent alongside them. The relay keeps
   * the two connections separate, so a person and their agent share a handle
   * without evicting each other.
   */
  role?: ConnectionRole;
  /** Role "agent" only: which of the member's agents this connection is. */
  agentId?: string;
  agentLabel?: string;
  /** Shared secret, when the relay requires one (any deployed relay should). */
  token?: string;
  onMessage: (msg: ServerMsg) => void;
  onStateChange: (state: ConnectionState) => void;
  /**
   * The relay closed this connection because another one claimed the same
   * identity. Reconnecting would fight the other machine forever, so the client
   * stops and reports instead.
   */
  onEvicted?: (reason: string) => void;
}

/**
 * Talks to the relay over WebSocket: joins on connect, reconnects with
 * exponential backoff (capped at 30s) and re-joins automatically, and queues
 * outbound messages while offline so callers never have to check state
 * before calling send().
 */
export class RelayClient {
  private ws: WebSocket | undefined;
  private state: ConnectionState = "offline";
  private backoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private queue: ClientMsg[] = [];
  private disposed = false;

  constructor(private readonly opts: RelayClientOptions) {}

  connect(): void {
    if (this.disposed) {
      return;
    }
    this.clearReconnectTimer();
    this.setState("connecting");

    const ws = new WebSocket(this.opts.url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.setState("online");
      const join: JoinMsg = {
        t: "join",
        room: this.opts.room,
        member: this.opts.member,
        role: this.opts.role ?? "human",
        agentId: this.opts.agentId,
        agentLabel: this.opts.agentLabel,
        token: this.opts.token,
      };
      this.sendRaw(join);
      this.flushQueue();
      this.startPing();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerMsg;
        this.opts.onMessage(msg);
      } catch (err) {
        console.error("mpa: failed to parse relay message", err);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.stopPing();
      if (this.disposed) {
        return;
      }
      this.setState("offline");

      // 4000 means the relay handed our slot to a newer connection with the
      // same identity. Reconnecting evicts *them*, they reconnect and evict us,
      // and the room fills with join/leave forever — which is exactly what two
      // machines sharing a GitHub account used to do. Stop and say why.
      if (code === EVICTED_CODE) {
        this.disposed = true;
        this.opts.onEvicted?.(reason.toString() || "another session took this identity");
        return;
      }

      // 4003 is an auth refusal. Retrying with the same bad token is pointless
      // and hammers the relay.
      if (code === UNAUTHORISED_CODE) {
        this.disposed = true;
        this.opts.onEvicted?.("the relay rejected this connection — check mpa.roomToken");
        return;
      }

      this.scheduleReconnect();
    });

    ws.on("error", () => {
      // "close" always follows "error" for ws sockets; reconnect is
      // scheduled there so we don't double-schedule here.
    });
  }

  /** Send now if connected, otherwise queue and flush on the next reconnect. */
  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    } else {
      this.queue.push(msg);
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  dispose(): void {
    this.disposed = true;
    this.clearReconnectTimer();
    this.stopPing();
    this.ws?.removeAllListeners();
    this.ws?.close();
    this.ws = undefined;
  }

  private sendRaw(msg: ClientMsg): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private flushQueue(): void {
    const pending = this.queue;
    this.queue = [];
    for (const msg of pending) {
      this.sendRaw(msg);
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: "ping" }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private setState(state: ConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.opts.onStateChange(state);
    }
  }
}
