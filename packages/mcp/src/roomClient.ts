/**
 * WebSocket client that attaches an agent to a room.
 *
 * Joins with role "agent", so the relay keeps it separate from its owner's
 * editor connection — a member and their agent are both live on the same handle
 * without evicting each other.
 */

import WebSocket = require("ws");
import type {
  ActionEntry,
  ClientMsg,
  RosterEntry,
  ServerMsg,
  TranscriptEntry,
} from "@mpa/protocol";

export interface RoomClientConfig {
  url: string;
  room: string;
  handle: string;
  displayName: string;
  repo?: string;
}

export class RoomClient {
  private socket?: WebSocket;
  private readonly transcript: TranscriptEntry[] = [];
  private roster: RosterEntry[] = [];
  private actions: ActionEntry[] = [];
  private host: string | undefined;
  /** Remote tool calls awaiting a reply from the member executing them. */
  private readonly pendingRemote = new Map<
    string,
    { resolve: (r: { content: string; isError: boolean }) => void; timer: NodeJS.Timeout }
  >();
  private nextRequest = 0;
  private ready?: Promise<void>;
  /** Index of the last entry already handed to the agent, so reads are incremental. */
  private cursor = 0;

  constructor(private readonly config: RoomClientConfig) {}

  connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const socket = new WebSocket(this.config.url);
      this.socket = socket;

      socket.on("open", () => {
        this.send({
          t: "join",
          room: this.config.room,
          role: "agent",
          member: {
            handle: this.config.handle,
            displayName: this.config.displayName,
            repo: this.config.repo,
          },
        });
        resolve();
      });

      socket.on("message", (raw: WebSocket.RawData) => this.receive(String(raw)));
      socket.on("error", (err: Error) => reject(err));
      socket.on("close", () => {
        this.socket = undefined;
        this.ready = undefined;
      });
    });
    return this.ready;
  }

  private receive(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "joined": {
        // A reconnect replays the whole transcript. Appending it onto what we
        // already hold would show the agent the conversation twice and, because
        // the cursor jumps to the new end, mark the genuinely unseen messages as
        // already read. Reconcile by id instead.
        const known = new Set(this.transcript.map((e) => e.id));
        const fresh = msg.transcript.filter((e) => !known.has(e.id));
        const firstAttach = this.transcript.length === 0;
        this.transcript.push(...fresh);
        this.roster = msg.roster;
        this.host = msg.workspaceHost;
        this.actions = msg.actions ?? [];
        // On first attach, everything before us is history rather than news.
        // On a reconnect, whatever arrived while we were away is genuinely new.
        if (firstAttach) {
          this.cursor = this.transcript.length;
        }
        break;
      }
      case "entry":
        this.transcript.push(msg.entry);
        break;
      case "roster":
        this.roster = msg.roster;
        this.host = msg.workspaceHost;
        break;
      case "action":
        this.actions.push(msg.entry);
        break;
      case "remoteToolReply": {
        const pending = this.pendingRemote.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRemote.delete(msg.requestId);
          pending.resolve({ content: msg.content, isError: msg.isError === true });
        }
        break;
      }
      default:
        break;
    }
  }

  /** Entries since the last call — what the agent has not yet seen. */
  takeNew(): TranscriptEntry[] {
    const fresh = this.transcript.slice(this.cursor);
    this.cursor = this.transcript.length;
    return fresh;
  }

  recent(limit: number): TranscriptEntry[] {
    this.cursor = this.transcript.length;
    return this.transcript.slice(-limit);
  }

  currentRoster(): RosterEntry[] {
    return this.roster;
  }

  currentActions(): ActionEntry[] {
    return this.actions;
  }

  workspaceHost(): string | undefined {
    return this.host;
  }

  /**
   * Act on another member's workspace.
   *
   * The request is executed on *their* machine, under their permissions and with
   * their approval — this agent never touches their disk directly. A generous
   * timeout, because the other end may be showing a human a confirmation dialog.
   */
  async remoteTool(
    targetHandle: string,
    name: string,
    input: Record<string, unknown>,
    timeoutMs = 300_000
  ): Promise<{ content: string; isError: boolean }> {
    const requestId = `rt_${this.nextRequest++}`;
    if (!this.send({ t: "remoteTool", requestId, targetHandle, name, input })) {
      // Never silently drop: an unsent request would look like a slow one.
      return { content: "Not connected to the room.", isError: true };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRemote.delete(requestId);
        resolve({
          content: `No answer from @${targetHandle} within ${timeoutMs / 1000}s — they may not have approved it.`,
          isError: true,
        });
      }, timeoutMs);
      this.pendingRemote.set(requestId, { resolve, timer });
    });
  }

  /**
   * Post to the room and confirm it landed.
   *
   * Reporting success without confirmation is worse than failing: the agent is
   * told it answered while the humans see silence. We wait for our own message
   * to come back on the broadcast, which is the only proof the relay accepted it.
   */
  async post(text: string, timeoutMs = 5000): Promise<boolean> {
    if (!this.send({ t: "say", text })) {
      return false;
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.transcript.some((e) => e.text === text && e.authorHandle === this.config.handle)) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  }

  private send(msg: ClientMsg): boolean {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  close(): void {
    this.socket?.close();
  }
}
