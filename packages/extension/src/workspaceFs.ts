// A read-only view of another member's workspace, as a real filesystem.
//
// Phase 5 let agents act on a member's machine but left the humans blind: the
// shared code was visible only to whoever's disk it lived on. Registering a
// FileSystemProvider means the host's repo opens in ordinary editor tabs —
// syntax highlighting, find-in-file, go-to-line — rather than as text pasted
// into chat. That is the difference between "collaborative VS Code" and a chat
// window that can print files.
//
// Two things make it usable rather than merely possible:
//
//   Caching. Every read is a relay round trip and possibly a human approval,
//   and VS Code stats aggressively — an uncached provider would be unbearable.
//
//   Invalidation from the action log. The room already broadcasts every write
//   with its path, so the provenance stream doubles as a cache-invalidation
//   stream for free: when an agent writes a file, exactly that path is evicted
//   and an open tab refreshes.

import * as vscode from "vscode";
import type { ActionEntry } from "@ripieno/protocol";

export const WORKSPACE_SCHEME = "ripieno-workspace";

/** Executes a tool on the host's machine and returns its raw result. */
export type RemoteCall = (
  name: string,
  input: Record<string, unknown>
) => Promise<{ content: string; isError: boolean }>;

interface CachedDir {
  entries: [string, vscode.FileType][];
  at: number;
}

interface CachedFile {
  bytes: Uint8Array;
  at: number;
}

/** Short enough that a change made outside the room is noticed reasonably soon. */
const TTL_MS = 30_000;
/**
 * How many files' bytes to keep.
 *
 * The TTL only made a read *miss*; nothing ever removed an entry, so browsing a
 * large repository retained every file's contents for the life of the session.
 * Oldest-read first, which for a filesystem view is close enough to least-used.
 */
const MAX_CACHED_FILES = 200;
const MAX_CACHED_DIRS = 400;

/**
 * Lines per `read_file` call when assembling a whole file.
 *
 * Kept well under what 50KB of bytes can hold at any plausible line length, so
 * the byte cap is the exception rather than the normal path — the resume logic
 * is correct either way, but a page that fits costs one round trip instead of
 * two.
 */
const PAGE_LINES = 500;
/** Refuse rather than page forever; ~250k lines is not an editor tab. */
const MAX_READ_PAGES = 500;

/**
 * The host's workspace, addressed as `ripieno-workspace:/<path>`.
 *
 * Deliberately read-only: `writeFile` throws `NoPermissions`, which makes VS
 * Code render the correct affordances rather than accepting edits and failing
 * on save. Changing a host file goes through *Propose change to host*, so the
 * owner sees a diff instead of a stream of approval prompts triggered by
 * autosave.
 */
export class WorkspaceFileSystem implements vscode.FileSystemProvider {
  private readonly dirs = new Map<string, CachedDir>();
  private readonly files = new Map<string, CachedFile>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  /** Set when a room has a host; cleared when it does not. */
  private call: RemoteCall | undefined;

  setRemote(call: RemoteCall | undefined): void {
    this.call = call;
    this.invalidateAll();
  }

  /**
   * A write happened on the host — evict exactly that path.
   *
   * Reading the action log rather than polling is what keeps an open tab honest
   * when somebody else's agent edits the file underneath it.
   */
  noteAction(entry: ActionEntry): void {
    if (entry.verb !== "wrote" && entry.verb !== "edited") return;
    // The parent listing may be wrong too — a write can create a file.
    this.invalidatePath(entry.target);
  }

  /**
   * Drop one path and its parent listing.
   *
   * Used for changes the room learned about from the host's filesystem rather
   * than from an action — an agent's own local write, or a human saving a file.
   */
  invalidatePath(relativePath: string): void {
    const key = normalise(relativePath);
    this.files.delete(key);
    this.dirs.delete(parentOf(key));
    this.changed.fire([{ type: vscode.FileChangeType.Changed, uri: uriFor(key) }]);
  }

  invalidateAll(): void {
    this.dirs.clear();
    this.files.clear();
  }

  /* ---------------------------------------------------------------- */
  /* FileSystemProvider                                                */
  /* ---------------------------------------------------------------- */

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const rel = pathOf(uri);
    // The root always exists as a directory; asking the host wastes a round trip
    // and fails before anyone has claimed the workspace.
    if (rel === "" || rel === ".") {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const cachedFile = this.files.get(rel);
    if (cachedFile && fresh(cachedFile.at)) {
      return { type: vscode.FileType.File, ctime: 0, mtime: cachedFile.at, size: cachedFile.bytes.length };
    }

    const result = await this.remote("stat", { path: rel });
    const [kind, size, mtime] = result.split("\t");
    return {
      type: kind === "dir" ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: Number(mtime) || 0,
      size: Number(size) || 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const rel = pathOf(uri) || ".";
    const cached = this.dirs.get(rel);
    if (cached && fresh(cached.at)) return cached.entries;

    const result = await this.remote("list_dir", { path: rel });
    const entries: [string, vscode.FileType][] = result
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [kind, , name] = line.split("\t");
        return [name, kind === "dir" ? vscode.FileType.Directory : vscode.FileType.File];
      });

    this.dirs.set(rel, { entries, at: Date.now() });
    evictOldest(this.dirs, MAX_CACHED_DIRS);
    return entries;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const rel = pathOf(uri);
    const cached = this.files.get(rel);
    if (cached && fresh(cached.at)) return cached.bytes;

    // Page until the file is complete. Asking for every line in one call does
    // not get you every line: the response is capped at 50KB of *bytes*
    // regardless of how many lines were requested, so a single call returned
    // the first 50KB of any larger file and nothing said so. An editor tab
    // showing a confident half-file is the worst available outcome, because
    // "Propose change to host" then writes that half back over the whole.
    const lines: string[] = [];
    let offset = 1;
    for (let page = 0; ; page++) {
      if (page >= MAX_READ_PAGES) {
        throw vscode.FileSystemError.Unavailable(
          `This file is too large to open from a shared workspace (over ${MAX_READ_PAGES} pages).`
        );
      }
      const result = await this.remote("read_file", { path: rel, offset, limit: PAGE_LINES });
      const parsed = parseReadPage(result);
      lines.push(...parsed.lines);
      if (parsed.next === undefined) break;
      if (parsed.next <= offset) {
        // No forward progress; looping would hang the tab rather than fail it.
        throw vscode.FileSystemError.Unavailable("This file could not be read completely.");
      }
      offset = parsed.next;
    }

    const bytes = new TextEncoder().encode(lines.join("\n"));
    this.files.set(rel, { bytes, at: Date.now() });
    evictOldest(this.files, MAX_CACHED_FILES);
    return bytes;
  }

  // Read-only. Throwing NoPermissions is what makes VS Code show the file as
  // unwritable instead of letting an edit look like it saved.
  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions(
      "This is another member's workspace. Use “Propose change to host” to send an edit for their approval."
    );
  }
  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only: deleting another member's files is not supported.");
  }
  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only: renaming another member's files is not supported.");
  }
  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Read-only.");
  }

  /** Nothing to watch: changes arrive through the action log, not the disk. */
  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  private async remote(name: string, input: Record<string, unknown>): Promise<string> {
    if (!this.call) {
      throw vscode.FileSystemError.Unavailable(
        "No shared workspace: nobody in this room is hosting one."
      );
    }
    const result = await this.call(name, input);
    if (result.isError) {
      // Map to FileNotFound where it plausibly is one, so VS Code shows a normal
      // "file not found" rather than an opaque failure.
      if (/not found|no such file|cannot (read|stat)/i.test(result.content)) {
        throw vscode.FileSystemError.FileNotFound(result.content);
      }
      throw vscode.FileSystemError.Unavailable(result.content);
    }
    return result.content;
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fresh(at: number): boolean {
  return Date.now() - at < TTL_MS;
}

export function uriFor(relativePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: WORKSPACE_SCHEME, path: `/${normalise(relativePath)}` });
}

function pathOf(uri: vscode.Uri): string {
  return normalise(uri.path);
}

function normalise(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}

function parentOf(relativePath: string): string {
  const cut = relativePath.lastIndexOf("/");
  return cut <= 0 ? "." : relativePath.slice(0, cut);
}

/** One page of `read_file` output, turned back into file content. */
export interface ReadPage {
  /** Content lines, numbering removed, in order. */
  lines: string[];
  /** Line to ask for next, or undefined when this page completes the file. */
  next?: number;
}

/**
 * Parse one page of `read_file` output.
 *
 * `read_file` prefixes a "path — lines a-b of n" header and numbers every line,
 * which is right for a model reading a page and wrong for an editor buffer. It
 * can also end in one of two markers, and conflating them corrupted files:
 *
 * - `[N more lines — call again with offset: X]` — you asked for a page and
 *   there is more. Ask again.
 * - `[truncated — output exceeds 50KB]` — the *byte* cap in capResult cut the
 *   response, possibly mid-line. This one was not filtered at all, so it landed
 *   in the editor buffer as though it were the last line of the file, with
 *   everything past 50KB simply gone. VS Code renders that as a complete file;
 *   "Propose change to host" then sends it back, and the host's copy of any file
 *   over 50KB is replaced by the first 50KB of itself. Silent, on somebody
 *   else's machine, and the tab gives no sign.
 *
 * Content lines are recognised by their numbering rather than by position, so a
 * partially-written final line — which is exactly what a byte cap leaves behind
 * — is dropped rather than kept as content. Whatever is dropped is re-requested,
 * so the parser is self-correcting: `next` resumes at the last line it is sure
 * about.
 */
export function parseReadPage(result: string): ReadPage {
  const raw = result.split("\n");
  // Not a paged read: some other tool's output, or an error. Pass it through.
  if (!/ — lines \d+-\d+ of \d+$/.test(raw[0] ?? "")) return { lines: raw };

  const kept: { n: number; text: string }[] = [];
  let more: number | undefined;
  let capped = false;

  for (const line of raw.slice(1)) {
    const numbered = /^\s*(\d+)\t(.*)$/.exec(line);
    if (numbered) {
      kept.push({ n: Number(numbered[1]), text: numbered[2] });
      continue;
    }
    const paged = /^\[\d+ more lines — call again with offset: (\d+)\]/.exec(line);
    if (paged) {
      more = Number(paged[1]);
      continue;
    }
    if (/^\[truncated — output exceeds/.test(line)) capped = true;
    // Anything else is the blank line capResult inserts before its marker, or
    // the remains of a line the byte cap bisected. Neither is content.
  }

  if (capped) {
    // The last line we kept may itself have been cut mid-way — it is only
    // trustworthy if something followed it. Drop it and ask again from there.
    kept.pop();
    const resume = kept.at(-1);
    if (resume === undefined) {
      // A single line longer than the cap. Paging cannot make progress, and
      // returning what we have would be the silent corruption all over again.
      throw vscode.FileSystemError.Unavailable(
        "A line in this file is too long to transfer. Open it on the host's machine."
      );
    }
    return { lines: kept.map((l) => l.text), next: resume.n + 1 };
  }

  return { lines: kept.map((l) => l.text), next: more };
}

/**
 * The whole of one page as an editor buffer. Kept for the single-page case and
 * because the exact format is a contract with `read_file`.
 *
 * No trailing-newline normalisation: this is an editor buffer, and a file that
 * genuinely ends in two blank lines must come back with two. Collapsing them
 * would corrupt the file quietly, which is the worst way to be wrong.
 */
export function stripReadFileHeader(result: string): string {
  return parseReadPage(result).lines.join("\n");
}

/** Drop the least recently read entries until the cache fits. */
function evictOldest<T extends { at: number }>(cache: Map<string, T>, limit: number): void {
  if (cache.size <= limit) return;
  const byAge = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [key] of byAge.slice(0, cache.size - limit)) cache.delete(key);
}
