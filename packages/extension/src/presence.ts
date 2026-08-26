// Sending presence at a rate the room can use.
//
// A provider stream describes a turn in far more detail than anyone wants to
// watch: a single Claude Code turn can produce dozens of frames a second. The
// relay refuses to broadcast faster than four a second per agent and expires
// presence nobody refreshes, and both of those are enforced there because a
// reporting host is exactly the thing that may be lying or dead.
//
// This is the same discipline applied at the source, for the ordinary reason:
// there is no point sending frames that will be dropped. It also mints the
// sequence the relay orders by, and keeps a long turn's presence alive with a
// heartbeat, so "Editing room.ts" during a four-minute edit does not quietly
// expire while it is still true.

import { MAX_PRESENCE_PATH_CHARS, MAX_PRESENCE_SUMMARY_CHARS } from "@ripieno/protocol";
import type { AgentActivity, AgentActivityMsg } from "@ripieno/protocol";

export interface PresenceUpdate {
  phase: AgentActivity;
  summary?: string;
  path?: string;
  line?: number;
  endLine?: number;
}

export interface PresenceLimits {
  /** Minimum gap between frames. Four a second, matching the relay. */
  minIntervalMs: number;
  /** How often an unchanged frame is re-sent so it does not expire. */
  heartbeatMs: number;
}

export const DEFAULT_PRESENCE_LIMITS: PresenceLimits = {
  minIntervalMs: 250,
  // Comfortably inside the relay's timeout, so a live turn survives a missed
  // beat rather than flickering out and back.
  heartbeatMs: 15_000,
};

function same(a: PresenceUpdate | undefined, b: PresenceUpdate): boolean {
  return (
    a?.phase === b.phase &&
    a?.summary === b.summary &&
    a?.path === b.path &&
    a?.line === b.line &&
    a?.endLine === b.endLine
  );
}

export class PresenceStream {
  private sequence = 0;
  private lastSentAt = 0;
  private last: PresenceUpdate | undefined;
  private pending: PresenceUpdate | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly send: (message: AgentActivityMsg) => void,
    private readonly limits: PresenceLimits = DEFAULT_PRESENCE_LIMITS
  ) {}

  /** What was last put on the wire, for a caller that needs to repeat it. */
  get current(): PresenceUpdate | undefined {
    return this.last;
  }

  publish(update: PresenceUpdate): void {
    const bounded = bound(update);
    if (same(this.pending ?? this.last, bounded)) return;
    const now = Date.now();
    const since = now - this.lastSentAt;
    if (since < this.limits.minIntervalMs) {
      // Only the newest description is worth sending: an update overtaken
      // inside the window describes something that is already over.
      this.pending = bounded;
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          const next = this.pending;
          this.pending = undefined;
          if (next) this.emit(next);
        }, this.limits.minIntervalMs - since);
        this.flushTimer.unref?.();
      }
      return;
    }
    this.emit(bounded);
  }

  /** Stop reporting. Called on detach, revocation and turn teardown. */
  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.pending = undefined;
    this.last = undefined;
  }

  private emit(update: PresenceUpdate): void {
    this.sequence += 1;
    this.last = update;
    this.lastSentAt = Date.now();
    this.send({ t: "agentActivity", sequence: this.sequence, ...update });
    this.startHeartbeat();
  }

  /**
   * Repeat the current frame while nothing changes.
   *
   * An agent editing one file for four minutes reports nothing new in that
   * time, and presence that expires mid-edit would be the surface lying in the
   * other direction. The relay treats an identical repeat as a heartbeat and
   * broadcasts nothing.
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (!this.last) return;
      this.sequence += 1;
      this.lastSentAt = Date.now();
      this.send({ t: "agentActivity", sequence: this.sequence, ...this.last });
    }, this.limits.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }
}

/** Apply the wire's own caps before sending, rather than sending what is cut. */
function bound(update: PresenceUpdate): PresenceUpdate {
  const summary = update.summary?.replace(/\s+/g, " ").trim().slice(0, MAX_PRESENCE_SUMMARY_CHARS);
  const path = update.path?.trim().slice(0, MAX_PRESENCE_PATH_CHARS);
  const line = positive(update.line);
  const endLine = line !== undefined ? positive(update.endLine) : undefined;
  return {
    phase: update.phase,
    summary: summary || undefined,
    path: path || undefined,
    line: path ? line : undefined,
    endLine: path && endLine !== undefined && line !== undefined && endLine >= line ? endLine : undefined,
  };
}

function positive(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
