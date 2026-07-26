/**
 * Hosted driver — one shared CMA session per room.
 *
 * This is the only file that knows about Anthropic. The room core stays
 * driver-agnostic so a future BYO driver (N local agents over MCP) can serve
 * the same protocol without touching anything else.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { RosterEntry } from "@mpa/protocol";
import type { Member, RoomStatus } from "@mpa/protocol";
import { SeenEvents, classify, envelope, resolveTarget, rosterPrompt } from "./roomCore.js";

/**
 * Deadlines for an outstanding tool call, by what the editor last told us.
 *
 * A single fixed timer cannot serve all three: it must be short enough to
 * notice a vanished member, yet longer than a human reading a modal, yet longer
 * again than a slow command. Previously one 60s timer covered all of them and
 * matched the editor's own command timeout exactly, so a member who took 61
 * seconds to click Run lost the race — the relay had already answered the agent
 * with an error, the command ran anyway, and its output went nowhere.
 *
 * `RUNNING` must stay strictly greater than the editor's COMMAND_TIMEOUT_MS;
 * a test asserts that, so the two can never converge again.
 */
export const TOOL_WINDOWS_MS = {
  /** No word from the editor at all — presume the member is unreachable. */
  dispatched: 20_000,
  /** The editor has the call and is working. */
  received: 60_000,
  /** A human is reading a confirmation dialog. Do not rush them. */
  "awaiting-approval": 300_000,
  /** A command is executing; the editor's own timeout will fire first. */
  running: 150_000,
} as const;

/** Stop narrating reconnect failures after this many in a row. */
const MAX_REPORTED_STREAM_FAILURES = 3;

/** Give up entirely after this many, rather than looping until the process dies. */
const MAX_STREAM_FAILURES = 10;

export interface DriverCallbacks {
  /** A complete agent message. Authoritative — supersedes any accumulated deltas. */
  onAgentMessage(entryId: string, text: string): void;
  /** Incremental agent text for live rendering. Never treat as final. */
  onAgentDelta(entryId: string, text: string): void;
  /** A preview ended with no final message — drop the partial bubble. */
  onAgentDeltaCancel(entryId: string): void;
  /** A workspace tool call, already validated and addressed to a present member. */
  onToolCall(handle: string, callId: string, name: string, input: Record<string, unknown>): void;
  onStatus(status: RoomStatus, waitingOn?: string): void;
  /** Per-turn token usage, for the cost-per-turn baseline the pricing story rests on. */
  onUsage(usage: Record<string, number>): void;
  onError(message: string): void;
}

export interface HostedDriverConfig {
  agentId: string;
  environmentId: string;
  /** Included in the session title so rooms are identifiable in the Console. */
  roomCode: string;
}

interface PendingCall {
  handle: string;
  timer: NodeJS.Timeout;
  /** What the editor last reported, for the timeout message and the room's status. */
  state: keyof typeof TOOL_WINDOWS_MS;
}

/** Minimal structural view of the delta preview events, which the room renders live. */
interface DeltaPreview {
  type: string;
  event?: { type?: string; id?: string };
  event_id?: string;
  delta?: { content?: { text?: string } };
}

export class HostedDriver {
  private sessionId?: string;
  private readonly seen = new SeenEvents();
  private readonly pending = new Map<string, PendingCall>();
  private roster: RosterEntry[] = [];
  /**
   * Previews opened by `event_start` and not yet closed by a final event. A
   * model request that ends early produces no final event, so without this the
   * partial text sits on screen forever, in nobody's transcript.
   */
  private readonly openPreviews = new Set<string>();
  private closed = false;
  /** Guards against two concurrent pump loops after a reconnect. */
  private pumping = false;

  constructor(
    private readonly client: Anthropic,
    private readonly config: HostedDriverConfig,
    private readonly cb: DriverCallbacks
  ) {}

  get id(): string | undefined {
    return this.sessionId;
  }

  /** Console trace URL — worth logging so a human can watch the room live. */
  get traceUrl(): string | undefined {
    return this.sessionId
      ? `https://platform.claude.com/workspaces/default/sessions/${this.sessionId}`
      : undefined;
  }

  async start(roster: RosterEntry[]): Promise<void> {
    this.roster = roster;
    const session = await this.client.beta.sessions.create({
      agent: this.config.agentId,
      environment_id: this.config.environmentId,
      title: `Room ${this.config.roomCode}`,
      metadata: { room: this.config.roomCode },
    });
    this.sessionId = session.id;

    // Stream first, then send. The stream only delivers events that occur after
    // it opens, so opening it after the roster message would drop the reply.
    void this.pump();
    await this.sendRoster(roster);
  }

  /**
   * The roster cannot ride in `initial_events` — a session's initial_events
   * accepts only user.message and user.define_outcome. It goes as a system
   * message immediately after create, and again whenever membership changes.
   */
  async sendRoster(roster: RosterEntry[]): Promise<void> {
    this.roster = roster;
    if (!this.sessionId) return;
    await this.client.beta.sessions.events.send(this.sessionId, {
      events: [
        {
          type: "system.message",
          content: [{ type: "text", text: rosterPrompt(roster) }],
        },
      ],
    });
  }

  /** Forward a member's message, wrapped so the agent always knows the author. */
  async say(member: Member, text: string): Promise<void> {
    if (!this.sessionId) throw new Error("session not started");
    await this.client.beta.sessions.events.send(this.sessionId, {
      events: [
        {
          type: "user.message",
          content: [{ type: "text", text: envelope(member, text) }],
        },
      ],
    });
  }

  ownerOfCall(callId: string): string | undefined {
    return this.pending.get(callId)?.handle;
  }

  /**
   * Answer a tool call the member's editor executed locally.
   *
   * Answering a call that is no longer pending would send a *second*
   * `user.custom_tool_result` for one `custom_tool_use_id` — an API-level
   * protocol violation. That is the normal outcome, not a corner case: the
   * editor's clock starts only after the user clicks through a modal with no
   * timeout, so any slow command loses the race against our own timeout.
   */
  async resolveToolCall(callId: string, content: string, isError: boolean): Promise<void> {
    const entry = this.pending.get(callId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(callId);
    await this.sendToolResult(callId, content, isError);
    this.reportWaitState();
  }

  private async sendToolResult(callId: string, content: string, isError: boolean): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.client.beta.sessions.events.send(this.sessionId, {
        events: [
          {
            type: "user.custom_tool_result",
            custom_tool_use_id: callId,
            content: [{ type: "text", text: content }],
            is_error: isError,
          },
        ],
      });
    } catch (err) {
      this.cb.onError(`failed to return tool result: ${describe(err)}`);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Event pump                                                        */
  /* ---------------------------------------------------------------- */

  /**
   * Consume the session stream, reconnecting on drop.
   *
   * SSE has no replay, so every (re)connect overlays fetched history on the
   * live stream and dedupes by event id. Skipping that would strand the room:
   * if the connection dies while a tool call is pending, the agent waits
   * forever for a result nobody sends.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    let backoff = 1000;
    let consecutiveFailures = 0;

    while (!this.closed && this.sessionId) {
      try {
        const stream = await this.client.beta.sessions.events.stream(this.sessionId, {
          event_deltas: ["agent.message"],
        });
        await this.replayHistory();
        backoff = 1000;
        consecutiveFailures = 0;

        for await (const event of stream) {
          if (this.closed) break;
          this.handle(event as unknown as DeltaPreview & Record<string, unknown>);
        }
      } catch (err) {
        if (this.closed) break;
        consecutiveFailures += 1;
        // Report the first few, then go quiet. onError appends a system entry
        // to the shared transcript *and* raises a modal in every member's
        // editor, so an unrecoverable failure (a deleted or expired session)
        // would otherwise nag the whole room every 30s forever and grow the
        // transcript without bound.
        if (consecutiveFailures <= MAX_REPORTED_STREAM_FAILURES) {
          this.cb.onError(`stream dropped, reconnecting: ${describe(err)}`);
        }
        if (consecutiveFailures >= MAX_STREAM_FAILURES) {
          this.cb.onError(
            `giving up on this room's agent session after ${consecutiveFailures} failed attempts — restart the room to retry.`
          );
          this.cb.onStatus("error");
          this.closed = true;
          break;
        }
      }
      if (this.closed) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
    this.pumping = false;
  }

  /** Fetch events emitted while we were disconnected; dedupe covers the overlap. */
  private async replayHistory(): Promise<void> {
    if (!this.sessionId) return;
    try {
      for await (const event of this.client.beta.sessions.events.list(this.sessionId)) {
        if (this.closed) break;
        this.handle(event as unknown as DeltaPreview & Record<string, unknown>);
      }
    } catch (err) {
      this.cb.onError(`could not replay history: ${describe(err)}`);
    }
  }

  private handle(event: DeltaPreview & Record<string, unknown>): void {
    // Delta previews are stream-only and carry no id of their own, so they are
    // dispatched before the dedupe gate.
    if (event.type === "event_delta") {
      const id = event.event_id;
      const text = event.delta?.content?.text;
      if (id && typeof text === "string") this.cb.onAgentDelta(id, text);
      return;
    }
    if (event.type === "event_start") {
      const id = event.event?.id;
      if (id && event.event?.type === "agent.message") this.openPreviews.add(id);
      return;
    }

    if (!this.seen.markNew(event as { id?: string })) return;

    switch (event.type) {
      case "agent.message": {
        const id = String(event.id ?? "");
        this.openPreviews.delete(id);
        this.cb.onAgentMessage(id, textOf(event.content));
        break;
      }

      case "agent.custom_tool_use":
        this.dispatchToolCall(event);
        break;

      case "span.model_request_end": {
        const usage = event.model_usage;
        if (usage && typeof usage === "object") {
          this.cb.onUsage(usage as Record<string, number>);
        }
        // Terminal for the request: anything still previewing never produced a
        // final event and must be withdrawn rather than left on screen.
        for (const id of this.openPreviews) this.cb.onAgentDeltaCancel(id);
        this.openPreviews.clear();
        break;
      }

      case "session.error":
        this.cb.onError(describeSessionError(event.error));
        break;

      default: {
        const disposition = classify(event as { type: string; stop_reason?: { type?: string } });
        if (disposition === "terminal") {
          this.cb.onStatus("idle");
        } else if (disposition === "awaiting-action") {
          const waiting = [...this.pending.values()][0]?.handle;
          this.cb.onStatus("awaiting-tool", waiting);
        } else if (event.type === "session.status_running") {
          this.cb.onStatus("thinking");
        }
      }
    }
  }

  /**
   * `agent.custom_tool_use` carries nothing identifying a member, so the agent
   * names its target in a `handle` input and we validate it here. An unusable
   * handle comes straight back as an errored result with a corrective message —
   * that is what lets the agent retry against a real member instead of the room
   * silently stalling.
   */
  private dispatchToolCall(event: Record<string, unknown>): void {
    const callId = String(event.id ?? "");
    const name = String(event.name ?? "");
    const input = (event.input ?? {}) as Record<string, unknown>;

    const target = resolveTarget(this.roster, input.handle);
    if (!target.ok) {
      void this.sendToolResult(callId, target.reason, true);
      return;
    }

    // An unanswered call parks the session on requires_action forever, which
    // blocks the whole room — not just the member who went offline.
    this.pending.set(callId, {
      handle: target.handle,
      state: "dispatched",
      timer: this.armTimer(callId, target.handle, "dispatched"),
    });
    this.cb.onToolCall(target.handle, callId, name, input);
    this.cb.onStatus("awaiting-tool", target.handle);
  }

  /**
   * The editor reporting progress. Each report buys the window its state
   * deserves — which is the whole point: waiting on a human is not the same as
   * waiting on a machine that may be gone.
   */
  noteToolProgress(handle: string, callId: string, state: keyof typeof TOOL_WINDOWS_MS): void {
    const entry = this.pending.get(callId);
    // Progress from anyone but the addressee is ignored, for the same reason a
    // result from them is: it would let one member stall another's call.
    if (!entry || entry.handle !== handle) return;
    clearTimeout(entry.timer);
    entry.state = state;
    entry.timer = this.armTimer(callId, handle, state);
    this.cb.onStatus("awaiting-tool", handle);
  }

  private armTimer(
    callId: string,
    handle: string,
    state: keyof typeof TOOL_WINDOWS_MS
  ): NodeJS.Timeout {
    const ms = TOOL_WINDOWS_MS[state];
    const timer = setTimeout(() => {
      this.pending.delete(callId);
      void this.sendToolResult(callId, describeTimeout(handle, state, ms), true);
      // Not unconditionally idle: with a fan-out across several members, one
      // timing out while others are still working would tell the room the agent
      // had finished when it plainly has not.
      this.reportWaitState();
    }, ms);
    // Never let a pending tool call hold the process open on its own.
    timer.unref?.();
    return timer;
  }

  /** Derive the room's wait state from what is genuinely still outstanding. */
  private reportWaitState(): void {
    const next = this.pending.values().next();
    if (next.done) {
      // Everything answered — the agent resumes; the session tells us when it
      // is actually finished.
      this.cb.onStatus("thinking");
    } else {
      this.cb.onStatus("awaiting-tool", next.value.handle);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: string; text: string } => {
      return !!b && typeof b === "object" && (b as { type?: string }).type === "text";
    })
    .map((b) => b.text)
    .join("");
}

function describeSessionError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; type?: string };
    return e.message ?? e.type ?? "unknown session error";
  }
  return "unknown session error";
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Say what actually went wrong, so the agent can choose differently rather than
 * retrying into the same wall.
 */
function describeTimeout(handle: string, state: keyof typeof TOOL_WINDOWS_MS, ms: number): string {
  const seconds = Math.round(ms / 1000);
  switch (state) {
    case "dispatched":
      return (
        `@${handle}'s editor never acknowledged this call within ${seconds}s — they are probably offline. ` +
        `Do not retry this tool against them; ask the room or use another present member.`
      );
    case "awaiting-approval":
      return (
        `@${handle} did not approve this within ${seconds}s. Treat it as declined — do not repeat the same ` +
        `request; say what you need and why, and let them decide.`
      );
    case "running":
      return (
        `The command on @${handle}'s machine exceeded ${seconds}s and its result was abandoned. It may still ` +
        `be running there. Prefer a narrower command, or ask them to report the outcome.`
      );
    default:
      return (
        `@${handle} did not respond within ${seconds}s. Do not retry this tool against them; ask the room ` +
        `or use another present member.`
      );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
