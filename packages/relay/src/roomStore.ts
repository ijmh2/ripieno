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
 * recreated, and a JSON file needs no service to operate. Point MPA_DATA_DIR at
 * a mounted volume and it survives redeploys too.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ActionEntry, AgentUsage, Member, RoomRole, TranscriptEntry } from "@mpa/protocol";

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
}

export interface RoomStore {
  load(code: string): Promise<RoomSnapshot | undefined>;
  save(code: string, snapshot: RoomSnapshot): Promise<void>;
}

/** The default: nothing survives, which is correct for tests and local runs. */
export class MemoryRoomStore implements RoomStore {
  async load(): Promise<undefined> {
    return undefined;
  }
  async save(): Promise<void> {
    // Intentionally nothing.
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

/** File-backed when MPA_DATA_DIR is set, otherwise in memory. */
export function createRoomStore(dataDir: string | undefined): RoomStore {
  return dataDir ? new FileRoomStore(dataDir) : new MemoryRoomStore();
}
