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
import type { ActionEntry } from "@mpa/protocol";

export const WORKSPACE_SCHEME = "mpa-workspace";

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
 * The host's workspace, addressed as `mpa-workspace:/<path>`.
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
    const key = normalise(entry.target);
    this.files.delete(key);
    // The parent listing may now be wrong too — a write can create a file.
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
    return entries;
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const rel = pathOf(uri);
    const cached = this.files.get(rel);
    if (cached && fresh(cached.at)) return cached.bytes;

    // Ask for the whole file: read_file pages by default, and a half-file in an
    // editor tab looks like a truncated file rather than a paged one.
    const result = await this.remote("read_file", { path: rel, offset: 1, limit: 1_000_000 });
    const bytes = new TextEncoder().encode(stripReadFileHeader(result));
    this.files.set(rel, { bytes, at: Date.now() });
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

/**
 * `read_file` prefixes a "path — lines a-b of n" header and numbers every line,
 * which is right for a model reading a page and wrong for an editor buffer.
 */
export function stripReadFileHeader(result: string): string {
  const lines = result.split("\n");
  if (!/ — lines \d+-\d+ of \d+$/.test(lines[0] ?? "")) return result;

  // No trailing-newline normalisation: this is an editor buffer, and a file
  // that genuinely ends in two blank lines must come back with two. Collapsing
  // them would corrupt the file quietly, which is the worst way to be wrong.
  return lines
    .slice(1)
    .filter((line) => !/^\[\d+ more lines/.test(line))
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}
