// User-facing reply fragments, paced before they reach the relay.
//
// The relay is the authority and enforces every limit again. This source-side
// stream exists so an ordinary provider cannot flood the socket with token-sized
// frames that the relay would only coalesce or reject. It never invents text:
// callers may publish only RunnerEvent `draft` deltas from a provider adapter.

import {
  MAX_AGENT_DRAFT_BYTES,
  MAX_AGENT_DRAFT_FRAME_BYTES,
  type AgentDraftCancelMsg,
  type AgentDraftMsg,
} from "@ripieno/protocol";

export interface DraftStreamLimits {
  minIntervalMs: number;
  maxFrameBytes: number;
  maxTurnBytes: number;
}

export const DEFAULT_DRAFT_STREAM_LIMITS: DraftStreamLimits = {
  minIntervalMs: 100,
  maxFrameBytes: MAX_AGENT_DRAFT_FRAME_BYTES,
  maxTurnBytes: MAX_AGENT_DRAFT_BYTES,
};

export class DraftStream {
  private sequence = 0;
  private turnBytes = 0;
  private pending = "";
  private sent = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly send: (message: AgentDraftMsg | AgentDraftCancelMsg) => void,
    private readonly limits: DraftStreamLimits = DEFAULT_DRAFT_STREAM_LIMITS
  ) {}

  /** Begin a turn after withdrawing any preview the previous turn left behind. */
  start(): void {
    this.cancel();
  }

  publish(delta: string): void {
    if (!delta || this.turnBytes >= this.limits.maxTurnBytes) return;
    const remaining = this.limits.maxTurnBytes - this.turnBytes;
    const accepted = takeUtf8Prefix(delta, remaining);
    if (!accepted) return;
    this.pending += accepted;
    this.turnBytes += Buffer.byteLength(accepted, "utf8");
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushOne();
      }, this.limits.minIntervalMs);
      this.timer.unref?.();
    }
  }

  /** Flush enough to establish the preview before final `say`, then reset. */
  complete(): void {
    this.clearTimer();
    // At the protocol maximum this is at most eight bounded frames. Sending
    // before `say` preserves socket order; the relay may still coalesce them.
    while (this.pending) this.flushOne(false);
    this.resetTurn();
  }

  /** Withdraw an incomplete preview, if any fragment reached the relay. */
  cancel(): void {
    this.clearTimer();
    if (this.sent) this.send({ t: "agentDraftCancel" });
    this.resetTurn();
  }

  dispose(): void {
    this.cancel();
  }

  private flushOne(scheduleNext = true): void {
    if (!this.pending) return;
    const delta = takeUtf8Prefix(this.pending, this.limits.maxFrameBytes);
    if (!delta) {
      this.pending = "";
      return;
    }
    this.pending = this.pending.slice(delta.length);
    this.sequence += 1;
    this.sent = true;
    this.send({ t: "agentDraft", delta, sequence: this.sequence });
    if (scheduleNext && this.pending && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushOne();
      }, this.limits.minIntervalMs);
      this.timer.unref?.();
    }
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private resetTurn(): void {
    this.pending = "";
    this.turnBytes = 0;
    this.sent = false;
  }
}

/** Longest whole-code-unit prefix whose UTF-8 representation fits `maxBytes`. */
export function takeUtf8Prefix(value: string, maxBytes: number): string {
  if (!value || maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  let end = low;
  // Do not emit half of a surrogate pair. Buffer would encode it as a
  // replacement character, changing provider-authored text on the wire.
  if (end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!) && /[\uDC00-\uDFFF]/.test(value[end] ?? "")) {
    end -= 1;
  }
  return value.slice(0, end);
}
