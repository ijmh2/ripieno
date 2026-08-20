import { createHash } from "crypto";

/**
 * Stable identity for a standing approval.
 *
 * The UI summary is intentionally truncated for readability, so it is never
 * safe to use as the trust key. Permission input has already crossed JSON and
 * is therefore serialisable; hashing the full value keeps long commands and
 * write bodies distinct without retaining another copy in memory.
 */
export function approvalInputHash(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input) ?? String(input)).digest("hex");
}
