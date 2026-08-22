/**
 * Keeping a room's conversation across restarts.
 *
 * Rooms were in memory only, so every relay restart — and every redeploy —
 * emptied every room and made everyone rejoin a blank transcript. That was a
 * deliberate deferral that stopped being reasonable once it had happened half a
 * dozen times in one afternoon.
 *
 * Deliberately a file per room rather than a database: a room's history is a
 * small append-mostly document, it is only ever read whole when the room is
 * recreated, and a JSON file needs no service to operate. Point RIPIENO_DATA_DIR at
 * a mounted volume and it survives redeploys too.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  ActionEntry,
  AgentUsage,
  Goal,
  GoalAuditEntry,
  GoalResultMsg,
  HandoffAuditEntry,
  HandoffOffer,
  HandoffResultMsg,
  Member,
  RoomRole,
  TranscriptEntry,
} from "@ripieno/protocol";
import {
  MAX_GOALS,
  MAX_GOAL_AUDIT_ENTRIES,
  MAX_GOAL_REQUESTS,
  MAX_HANDOFFS,
  MAX_HANDOFF_AUDIT_ENTRIES,
  MAX_HANDOFF_REQUESTS,
} from "@ripieno/protocol";

/** Durable idempotency receipt. Its fingerprint includes the relay-derived actor. */
export interface GoalRequestReceipt {
  actorHandle: string;
  requestId: string;
  fingerprint: string;
  kind: "create" | "transition";
  goalId?: string;
  result: GoalResultMsg;
}

/** Durable idempotency receipt. Its fingerprint includes the relay-derived actor. */
export interface HandoffRequestReceipt {
  actorHandle: string;
  requestId: string;
  fingerprint: string;
  kind: "offer" | "decision";
  handoffId?: string;
  result: HandoffResultMsg;
}

export interface RoomSnapshot {
  transcript: TranscriptEntry[];
  actions: ActionEntry[];
  /** Everyone who has been in the room, so the roster survives a restart. */
  members: Member[];
  /**
   * What each member may do. Optional so a snapshot written before roles
   * existed still loads — everyone in it is simply a member again.
   */
  roles?: Record<string, RoomRole>;
  /** Per-agent totals, so a restart does not reset everyone's spend to zero. */
  usage?: AgentUsage[];
  goals?: Goal[];
  goalAudit?: GoalAuditEntry[];
  goalRequests?: GoalRequestReceipt[];
  roomRevision?: number;
  handoffs?: HandoffOffer[];
  handoffAudit?: HandoffAuditEntry[];
  handoffRequests?: HandoffRequestReceipt[];
  handoffRevision?: number;
}

export interface RoomStore {
  load(code: string): Promise<RoomSnapshot | undefined>;
  save(code: string, snapshot: RoomSnapshot): Promise<void>;
}

/** The default: survives room reaping for this relay process, but not a restart. */
export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, RoomSnapshot>();

  async load(code: string): Promise<RoomSnapshot | undefined> {
    const snapshot = this.rooms.get(code);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
  async save(code: string, snapshot: RoomSnapshot): Promise<void> {
    // Reaping an empty room must release sockets and drivers, not its state.
    // Clone so a revived Room cannot mutate the store by retaining references.
    this.rooms.set(code, structuredClone(snapshot));
  }
}

/**
 * How much history a restart brings back.
 *
 * A room left running for weeks should not reload a megabyte of chat before
 * anyone can speak, and the tail is what people actually need.
 *
 * Two caps, not one, and the byte cap is the important one. Counting entries
 * alone assumes entries are small; a benchmark of 50 large messages produced a
 * 9.8MB snapshot that the debounced save then rewrote in full every second.
 * Since the relay is otherwise pure routing — ~0.06ms of CPU per message — that
 * would have made the one disk-touching path the only part that scales badly.
 */
const MAX_PERSISTED_TRANSCRIPT = 500;
const MAX_PERSISTED_ACTIONS = 200;
const MAX_PERSISTED_BYTES = 1_000_000;

/**
 * Keep the newest entries that fit the budget.
 *
 * Oversized entries are truncated rather than dropped: a member returning to the
 * room should see that something long was said and by whom, which a hole in the
 * transcript would not tell them.
 */
function fitToBudget(entries: TranscriptEntry[], budget: number): TranscriptEntry[] {
  const kept: TranscriptEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    const size = JSON.stringify(entry).length;
    if (used + size > budget) {
      if (kept.length === 0) {
        // A single entry larger than the whole budget. Keep its head so the
        // room is never restored completely empty.
        const text = (entry as { text?: string }).text ?? "";
        kept.unshift({ ...entry, text: `${text.slice(0, 2000)}\n…[truncated]` } as TranscriptEntry);
      }
      break;
    }
    used += size;
    kept.unshift(entry);
  }
  return kept;
}

export class FileRoomStore implements RoomStore {
  constructor(private readonly dir: string) {}

  /**
   * One save at a time per room, and a temp file per call.
   *
   * Both saves used to write `<room>.<pid>.tmp` and rename it, so two concurrent
   * saves of one room raced: the loser's rename failed with ENOENT into a
   * swallowed catch, and which snapshot survived was decided by rename order
   * rather than by recency. The window also allowed a half-written temp to be
   * renamed into place, at which point load() returns undefined and the room's
   * whole history is silently gone.
   */
  private readonly writes = new Map<string, Promise<void>>();
  private seq = 0;

  async load(code: string): Promise<RoomSnapshot | undefined> {
    try {
      const raw = await readFile(this.pathFor(code), "utf8");
      const parsed = JSON.parse(raw) as Partial<RoomSnapshot>;
      return {
        transcript: parsed.transcript ?? [],
        actions: parsed.actions ?? [],
        members: parsed.members ?? [],
        roles: parsed.roles ?? {},
        usage: parsed.usage ?? [],
        goals: (parsed.goals ?? []).slice(-MAX_GOALS),
        goalAudit: (parsed.goalAudit ?? []).slice(-MAX_GOAL_AUDIT_ENTRIES),
        goalRequests: (parsed.goalRequests ?? []).slice(-MAX_GOAL_REQUESTS),
        roomRevision: Number.isSafeInteger(parsed.roomRevision) ? parsed.roomRevision : 0,
        handoffs: (parsed.handoffs ?? []).slice(-MAX_HANDOFFS),
        handoffAudit: (parsed.handoffAudit ?? []).slice(-MAX_HANDOFF_AUDIT_ENTRIES),
        handoffRequests: (parsed.handoffRequests ?? []).slice(-MAX_HANDOFF_REQUESTS),
        handoffRevision: Number.isSafeInteger(parsed.handoffRevision)
          ? parsed.handoffRevision
          : 0,
      };
    } catch {
      // A missing file is the normal case for a new room; a corrupt one should
      // not stop the room existing, so both start empty.
      return undefined;
    }
  }

  async save(code: string, snapshot: RoomSnapshot): Promise<void> {
    const previous = this.writes.get(code) ?? Promise.resolve();
    const mine = previous.catch(() => undefined).then(() => this.write(code, snapshot));
    this.writes.set(
      code,
      mine.catch(() => undefined)
    );
    return mine;
  }

  private async write(code: string, snapshot: RoomSnapshot): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const trimmed: RoomSnapshot = {
      transcript: fitToBudget(snapshot.transcript.slice(-MAX_PERSISTED_TRANSCRIPT), MAX_PERSISTED_BYTES),
      actions: snapshot.actions.slice(-MAX_PERSISTED_ACTIONS),
      members: snapshot.members,
      roles: snapshot.roles,
      usage: snapshot.usage,
      goals: (snapshot.goals ?? []).slice(-MAX_GOALS),
      goalAudit: (snapshot.goalAudit ?? []).slice(-MAX_GOAL_AUDIT_ENTRIES),
      goalRequests: (snapshot.goalRequests ?? []).slice(-MAX_GOAL_REQUESTS),
      roomRevision: snapshot.roomRevision ?? 0,
      handoffs: (snapshot.handoffs ?? []).slice(-MAX_HANDOFFS),
      handoffAudit: (snapshot.handoffAudit ?? []).slice(-MAX_HANDOFF_AUDIT_ENTRIES),
      handoffRequests: (snapshot.handoffRequests ?? []).slice(-MAX_HANDOFF_REQUESTS),
      handoffRevision: snapshot.handoffRevision ?? 0,
    };

    // Write then rename: a relay killed mid-write would otherwise leave a
    // truncated file, and losing the history to a crash while *saving* it would
    // be a particularly annoying way to fail.
    const target = this.pathFor(code);
    const temp = `${target}.${process.pid}.${this.seq++}.tmp`;
    await writeFile(temp, JSON.stringify(trimmed), "utf8");
    await rename(temp, target);
  }

  /**
   * Room codes come from clients and end up as filenames.
   *
   * Sanitising alone was not enough: "a/b", "a b" and "a_b" all flattened to the
   * same name, so three distinct rooms shared one history file — reading each
   * other's transcript on restore and overwriting it on save. A code that is
   * already a safe filename is used as-is, so existing history keeps its name;
   * anything that had to be changed carries a hash of the original, which cannot
   * collide.
   */
  private pathFor(code: string): string {
    const safe = code.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "room";
    if (safe === code) return path.join(this.dir, `${safe}.json`);
    const digest = createHash("sha256").update(code).digest("hex").slice(0, 12);
    return path.join(this.dir, `${safe}-${digest}.json`);
  }
}

/** File-backed when RIPIENO_DATA_DIR is set, otherwise in memory. */
export function createRoomStore(dataDir: string | undefined): RoomStore {
  return dataDir ? new FileRoomStore(dataDir) : new MemoryRoomStore();
}
