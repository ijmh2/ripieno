/** Operator-controlled admission, separate from a member's in-room role. */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export interface RoomPolicyConfig {
  /** Exact room codes, mapped to GitHub logins (case-insensitive). */
  rooms: Readonly<Record<string, readonly string[]>>;
}

function invalid(detail: string): never {
  throw new Error(`Invalid room admission policy: ${detail}`);
}

/** Validate at startup; a typo must never fall back to the shared-token mode. */
export function parseRoomPolicy(raw: unknown): RoomPolicyConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalid("expected an object containing rooms");
  }
  const fields = Object.keys(raw);
  if (fields.length !== 1 || fields[0] !== "rooms") {
    return invalid("only the rooms field is supported");
  }
  const rooms = (raw as Record<string, unknown>).rooms;
  if (!rooms || typeof rooms !== "object" || Array.isArray(rooms)) {
    return invalid("rooms must map room codes to arrays of GitHub logins");
  }
  const entries: Array<[string, string[]]> = [];
  const storageKeys = new Set<string>();
  for (const [code, logins] of Object.entries(rooms)) {
    if (!code || code.trim() !== code) {
      return invalid("room codes must be nonempty and have no surrounding whitespace");
    }
    // FileRoomStore preserves short safe names and hashes all other codes.
    // Reject aliases, including case-only aliases on Windows, so two policy
    // entries cannot grant different people access to the same history file.
    const safe = code.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "room";
    const storageKey = (safe === code
      ? safe
      : `${safe}-${createHash("sha256").update(code).digest("hex").slice(0, 12)}`
    ).toLowerCase();
    if (storageKeys.has(storageKey)) return invalid("room codes must not share a history filename, including case-only differences");
    storageKeys.add(storageKey);
    if (!Array.isArray(logins) || logins.length === 0) {
      return invalid("each configured room needs a nonempty array of GitHub logins");
    }
    const handles = new Set<string>();
    for (const login of logins) {
      if (
        typeof login !== "string" ||
        !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(login) ||
        login.includes("--")
      ) {
        return invalid("allowlist entries must be GitHub logins without @ prefixes or whitespace");
      }
      const handle = login.toLowerCase();
      if (handles.has(handle)) return invalid("duplicate GitHub login in a room allowlist");
      handles.add(handle);
    }
    entries.push([code, [...handles]]);
  }
  return { rooms: Object.fromEntries(entries) };
}

/** Copy into private sets so later mutation of a caller's config cannot grant access. */
export function compileRoomPolicy(raw: unknown): (room: string, verifiedHandle: string) => boolean {
  const config = parseRoomPolicy(raw);
  const rooms = new Map(
    Object.entries(config.rooms).map(([code, handles]) => [code, new Set(handles)])
  );
  return (room, verifiedHandle) => rooms.get(room)?.has(verifiedHandle.toLowerCase()) === true;
}

/** Missing means trusted-team mode; an unreadable or invalid configured file is fatal. */
export async function loadRoomPolicy(file: string | undefined): Promise<RoomPolicyConfig | undefined> {
  if (file === undefined) return undefined;
  if (!file.trim()) return invalid("RIPIENO_ROOM_POLICY_FILE must name a file");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch {
    return invalid("could not read RIPIENO_ROOM_POLICY_FILE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(contents.replace(/^\uFEFF/, ""));
  } catch {
    return invalid("RIPIENO_ROOM_POLICY_FILE must contain valid JSON");
  }
  return parseRoomPolicy(raw);
}
