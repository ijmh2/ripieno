/**
 * The workspace tools, with no editor in them.
 *
 * These used to live inside the VS Code extension, which meant the shared
 * workspace could only ever be somebody's laptop: close the window and the
 * room's codebase went with it. Splitting them out lets a headless container
 * answer exactly the same tool calls.
 *
 * The split is a *move*, not a reimplementation, and that was the whole reason
 * to do it this way round. `workspaceFs.stripReadFileHeader()` parses the exact
 * bytes `read_file` emits, so a second implementation that formatted output even
 * slightly differently would silently corrupt every file opened from the
 * container — the kind of bug that looks like nothing until someone loses work.
 *
 * What stayed behind in the extension is what genuinely needs an editor: showing
 * a diff, applying a `WorkspaceEdit`, reading the Problems panel, knowing what
 * the member is looking at. Those enter here as the `ApprovalGate` seam.
 */

import * as path from "path";
import * as fs from "fs/promises";
import { realpath as fsRealpath } from "fs/promises";
import type { Dirent } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
import type { ToolProgressState } from "@ripieno/protocol";
import { COMMAND_TIMEOUT_MS } from "@ripieno/protocol";
import { resolveSafePath, confineToWorkspace, sanitizeGlob, type SafePath } from "./paths.js";
import { walkFiles } from "./walk.js";

export { resolveSafePath, confineToWorkspace, isInside, sanitizeGlob } from "./paths.js";
export type { SafePath } from "./paths.js";
export { globToRegExp, walkFiles } from "./walk.js";

const execAsync = promisify(exec);

export const MAX_RESULT_BYTES = 50 * 1024;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_MATCHES = 300;
const MAX_SEARCH_FILES = 2000;
/** Lines returned by read_file when the caller does not ask for a range. */
const DEFAULT_READ_LINES = 2000;

/** Never descended into. Listing them would bury the repo and make every call slow. */
const LIST_EXCLUDE: ReadonlySet<string> = new Set(["node_modules", ".git"]);
/** Search additionally skips build output, which is noise the agent never wants. */
const SEARCH_EXCLUDE: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
]);

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/**
 * Tells the relay how far this call has got.
 *
 * Without it the relay cannot distinguish a member who has vanished from one
 * reading a confirmation dialog from a genuinely slow command, and has to pick
 * a single timeout that is wrong for at least two of the three.
 */
export type ProgressReporter = (state: ToolProgressState) => void;

/**
 * Who asked, when the request came from another member's agent.
 *
 * A member approving a change to their own files must be told whose agent wants
 * it. Once agents can reach across machines, "an agent wants permission" is no
 * longer enough information to decide with.
 */
export interface Requester {
  label: string;
  handle: string;
}

/** A change the core has computed but deliberately not written. */
export interface WriteProposal {
  /** The path as the agent gave it — used in messages, never to resolve. */
  rawPath: string;
  abs: string;
  proposed: string;
  existed: boolean;
  requester?: Requester;
  report: ProgressReporter;
}

/**
 * Everything that differs between an editor and a container.
 *
 * The editor shows a diff and applies a `WorkspaceEdit` so the member can undo
 * the agent with Cmd+Z; the container writes the file and commits it as the
 * acting agent. Both are "apply this change" — the difference is entirely in how
 * a human is (or is not) consulted, which is exactly the seam worth having.
 */
export interface ApprovalGate {
  /**
   * May this command run? The gate owns the whole decision including any
   * allowlist, and is responsible for reporting `awaiting-approval` itself if it
   * is about to block on a human — the relay's timeout depends on knowing the
   * difference between a slow command and a slow person.
   */
  approveCommand(
    command: string,
    requester: Requester | undefined,
    report: ProgressReporter
  ): Promise<boolean>;

  /** Land the change, however this host lands changes. */
  applyWrite(proposal: WriteProposal): Promise<ToolResult>;

  /**
   * A command has finished and may have changed files.
   *
   * Writes go through applyWrite, which commits and announces them — but a
   * command does not. `prettier --write` or a codegen step left the workspace
   * dirty, uncommitted and invisible: nothing told the room, so every member's
   * cache kept serving the old bytes, and the changes vanished with the
   * container. An editor host needs none of this; its own filesystem watcher
   * already sees it.
   */
  afterCommand?(requester: Requester | undefined): Promise<void>;
}

export interface WorkspaceCoreOptions {
  /** Where the workspace is. A function because an editor's root can change. */
  resolveRoot: () => SafePath;
  gate: ApprovalGate;
  /**
   * No human sees what runs here — a container rather than somebody's editor.
   *
   * Commands then get a stripped environment, because the room can have an agent
   * run anything the allowlist permits and nobody is present to notice.
   */
  unattended?: boolean;
}

/** Tool names this core answers. Anything else belongs to the host. */
const OWNED = new Set([
  "read_file",
  "list_files",
  "search",
  "git_status",
  "run_command",
  "write_file",
  "edit_file",
  "list_dir",
  "stat",
]);

export class WorkspaceCore {
  constructor(private readonly options: WorkspaceCoreOptions) {}

  static handles(name: string): boolean {
    return OWNED.has(name);
  }

  /**
   * Run a tool, or return undefined if it belongs to the host.
   *
   * Never throws — every failure mode is reported as {content, isError: true},
   * because a thrown error becomes a dead tool call and a room that looks hung.
   */
  async execute(
    name: string,
    input: Record<string, unknown>,
    report: ProgressReporter = () => {},
    requester?: Requester
  ): Promise<ToolResult | undefined> {
    if (!OWNED.has(name)) return undefined;
    try {
      switch (name) {
        case "read_file":
          return await this.readFile(input);
        case "list_files":
          return await this.listFiles(input);
        case "search":
          return await this.search(input);
        case "git_status":
          return await this.gitStatus();
        case "run_command":
          return await this.runCommand(input, report, requester);
        case "write_file":
          return await this.writeFile(input, report, requester);
        case "edit_file":
          return await this.editFile(input, report, requester);
        case "list_dir":
          return await this.listDir(input);
        case "stat":
          return await this.stat(input);
        default:
          return { content: `Unknown tool "${name}".`, isError: true };
      }
    } catch (err) {
      return { content: `Tool "${name}" failed: ${errText(err)}`, isError: true };
    }
  }

  private root(): SafePath {
    return this.options.resolveRoot();
  }

  /**
   * The root as it really is on disk.
   *
   * `resolveSafePath` returns resolved paths, so everything that compares
   * against the root has to be in the same space or the two disagree the moment
   * any ancestor is a link — on macOS `/var` is a symlink to `/private/var`, so
   * a temp directory alone is enough to break it. Cached, because this is on the
   * path of every tool call.
   */
  private async rootReal(): Promise<SafePath> {
    const root = this.root();
    if (!root.ok) return root;
    if (this.realRootFor !== root.abs) {
      try {
        this.realRootCache = await fsRealpath(root.abs);
        this.realRootFor = root.abs;
      } catch {
        return { ok: false, reason: "The workspace root does not exist." };
      }
    }
    return { ok: true, abs: this.realRootCache };
  }
  private realRootFor = "";
  private realRootCache = "";

  private async safe(rawPath: string): Promise<SafePath> {
    const root = this.root();
    if (!root.ok) return root;
    return resolveSafePath(root.abs, rawPath);
  }

  /* ---------------------------------------------------------------- */
  /* Reading                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * Read a file, optionally a line range.
   *
   * Without a range a large file was permanently half-readable: it truncated at
   * 50KB with no way to ask for the rest. Line numbers and a total let the agent
   * page through instead of guessing what it missed.
   *
   * The exact format here is a contract, not a preference — `stripReadFileHeader`
   * in the extension parses it back. Changing the header, the padding or the tab
   * silently corrupts every file opened from a shared workspace.
   */
  private async readFile(input: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const safe = await this.safe(rawPath);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    const buf = await fs.readFile(safe.abs);
    const lines = buf.toString("utf8").split("\n");
    const total = lines.length;

    const offset = Math.max(1, toInt(input.offset, 1));
    const limit = Math.max(1, toInt(input.limit, DEFAULT_READ_LINES));
    const start = Math.min(offset, total);
    const end = Math.min(start + limit - 1, total);

    const numbered = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
      .join("\n");

    const header = `${rawPath} — lines ${start}-${end} of ${total}`;
    const more =
      end < total ? `\n\n[${total - end} more lines — call again with offset: ${end + 1}]` : "";
    return capResult(`${header}\n${numbered}${more}`);
  }

  private async listFiles(input: Record<string, unknown>): Promise<ToolResult> {
    const root = await this.rootReal();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const dir = typeof input.dir === "string" && input.dir.length > 0 ? input.dir : ".";
    const glob = sanitizeGlob(typeof input.glob === "string" ? input.glob : "**/*");

    const safe = await this.safe(dir);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    const rel = path.relative(root.abs, safe.abs);
    const scoped = rel ? `${rel}/${glob}` : glob;

    const found = await walkFiles(root.abs, safe.abs, scoped, {
      exclude: LIST_EXCLUDE,
      limit: MAX_LIST_RESULTS,
    });
    const confined = await confineToWorkspace(found, root.abs);
    const lines = confined
      .map((abs) => path.relative(root.abs, abs))
      .sort((a, b) => a.localeCompare(b));
    return capResult(lines.length > 0 ? lines.join("\n") : "(no files found)");
  }

  /**
   * Immediate children of a directory, with type and size.
   *
   * `list_files` cannot answer this: it is a flat glob of matches, so it can
   * neither say what is directly inside a directory nor distinguish a file from
   * a folder. A filesystem provider needs both, on every expand.
   *
   * Output is line-oriented and machine-parsable — `type\tsize\tname` — because
   * it is consumed by code as often as by a model.
   */
  private async listDir(input: Record<string, unknown>): Promise<ToolResult> {
    const rel = typeof input.path === "string" && input.path.trim() !== "" ? input.path : ".";
    const safe = await this.safe(rel);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(safe.abs, { withFileTypes: true });
    } catch (err) {
      return { content: `Cannot read ${rel}: ${errText(err)}`, isError: true };
    }

    const rows: string[] = [];
    for (const entry of entries) {
      if (LIST_EXCLUDE.has(entry.name)) continue;
      const abs = path.join(safe.abs, entry.name);
      let isDir = entry.isDirectory();
      let size = 0;
      try {
        // stat rather than lstat so a symlinked directory reads as a directory,
        // matching what the editor's provider showed.
        const info = await fs.stat(abs);
        isDir = info.isDirectory();
        size = isDir ? 0 : info.size;
      } catch {
        // A broken symlink or a race with a delete: report it as empty rather
        // than failing the whole listing.
      }
      rows.push(`${isDir ? "dir" : "file"}\t${size}\t${entry.name}`);
    }
    rows.sort();
    return capResult(rows.join("\n"));
  }

  /** Type, size and mtime for one path — what a provider needs before reading. */
  private async stat(input: Record<string, unknown>): Promise<ToolResult> {
    const rel = requireString(input, "path");
    const safe = await this.safe(rel);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    try {
      const info = await fs.stat(safe.abs);
      const kind = info.isDirectory() ? "dir" : "file";
      return { content: `${kind}\t${info.size}\t${Math.round(info.mtimeMs)}` };
    } catch (err) {
      return { content: `Cannot stat ${rel}: ${errText(err)}`, isError: true };
    }
  }

  private async search(input: Record<string, unknown>): Promise<ToolResult> {
    const root = await this.rootReal();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const query = requireString(input, "query");
    const glob = sanitizeGlob(typeof input.glob === "string" ? input.glob : "**/*");

    const found = await walkFiles(root.abs, root.abs, glob, {
      exclude: SEARCH_EXCLUDE,
      limit: MAX_SEARCH_FILES,
    });
    const confined = await confineToWorkspace(found, root.abs);

    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const abs of confined) {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        break;
      }
      let text: string;
      try {
        text = (await fs.readFile(abs)).toString("utf8");
      } catch {
        continue; // binary or unreadable — skip rather than fail the whole search
      }
      const rel = path.relative(root.abs, abs);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
        if (lines[i]!.toLowerCase().includes(needle)) {
          matches.push(`${rel}:${i + 1}: ${lines[i]!.trim()}`);
        }
      }
    }
    return capResult(matches.length > 0 ? matches.join("\n") : "No matches.");
  }

  /**
   * Working tree state, via porcelain rather than the editor's Git API.
   *
   * The extension used `vscode.extensions.getExtension("vscode.git")`, which a
   * container does not have and which could fail with "Git extension is not
   * available" even in the editor. Porcelain emits the same `XY path` format the
   * old code reconstructed by hand, so this is one implementation instead of two
   * that have to be kept agreeing.
   */
  private async gitStatus(): Promise<ToolResult> {
    const root = this.root();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    try {
      const { stdout } = await execAsync("git status --porcelain", {
        cwd: root.abs,
        timeout: 30_000,
        maxBuffer: MAX_RESULT_BYTES * 4,
      });
      const rows = stdout.split("\n").filter((line) => line.trim().length > 0);
      if (rows.length === 0) {
        return { content: "Working tree clean." };
      }
      return capResult(rows.sort().join("\n"));
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr ?? e.message ?? "").trim();
      if (/not a git repository/i.test(detail)) {
        return { content: "No git repository is open in this workspace.", isError: true };
      }
      return { content: `git status failed: ${detail || errText(err)}`, isError: true };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Running                                                           */
  /* ---------------------------------------------------------------- */

  private async runCommand(
    input: Record<string, unknown>,
    report: ProgressReporter,
    requester?: Requester
  ): Promise<ToolResult> {
    const root = this.root();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const command = requireString(input, "command");

    if (!(await this.options.gate.approveCommand(command, requester, report))) {
      return { content: `The user declined to run: ${command}`, isError: true };
    }

    report("running");
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root.abs,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES * 4,
        env: commandEnv(requester, this.options.unattended === true),
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      await this.options.gate.afterCommand?.(requester);
      return capResult(combined.length > 0 ? combined : "(command produced no output)");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      // A failing command can still have written files before it failed.
      await this.options.gate.afterCommand?.(requester).catch(() => undefined);
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return { ...capResult(combined || "Command failed."), isError: true };
    }
  }

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  private async writeFile(
    input: Record<string, unknown>,
    report: ProgressReporter,
    requester?: Requester
  ): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const content = requireString(input, "content");
    return this.propose(rawPath, content, report, requester);
  }

  /**
   * Replace an exact string. Failing loudly on a non-unique match is deliberate:
   * silently editing the wrong occurrence in someone else's workspace is far
   * worse than making the agent be more specific.
   */
  private async editFile(
    input: Record<string, unknown>,
    report: ProgressReporter,
    requester?: Requester
  ): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const oldText = requireString(input, "old_text");
    const newText = requireString(input, "new_text");

    const safe = await this.safe(rawPath);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    const current = (await fs.readFile(safe.abs)).toString("utf8");
    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) {
      return { content: `old_text was not found in ${rawPath}.`, isError: true };
    }
    if (occurrences > 1) {
      return {
        content: `old_text appears ${occurrences} times in ${rawPath}. Include more surrounding context so it identifies exactly one place.`,
        isError: true,
      };
    }
    return this.propose(rawPath, current.replace(oldText, newText), report, requester);
  }

  /** Compute the change, then hand it to the host to approve and apply. */
  private async propose(
    rawPath: string,
    proposed: string,
    report: ProgressReporter,
    requester?: Requester
  ): Promise<ToolResult> {
    const safe = await this.safe(rawPath);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }

    const existed = await fileExists(safe.abs);
    const current = existed ? (await fs.readFile(safe.abs)).toString("utf8") : "";
    if (existed && current === proposed) {
      return { content: `${rawPath} already has exactly that content; nothing to change.` };
    }

    return this.options.gate.applyWrite({
      rawPath,
      abs: safe.abs,
      proposed,
      existed,
      requester,
      report,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Helpers, shared with the hosts                                      */
/* ------------------------------------------------------------------ */

/**
 * Environment for a command run on someone's behalf.
 *
 * When another member's agent is driving, git authorship follows the agent. The
 * committer stays whoever runs the process, which is the honest description of
 * what happened: their agent authored it, this machine committed it. Without
 * this, provenance quietly collapses into the host's identity the moment work is
 * shared — the exact failure the shared workspace exists to avoid.
 */
export function commandEnv(requester?: Requester, unattended = false): NodeJS.ProcessEnv {
  const env = withoutSecrets(process.env, unattended);
  if (!requester) return env;
  return {
    ...env,
    GIT_AUTHOR_NAME: requester.label,
    GIT_AUTHOR_EMAIL: `${requester.handle}+agent@users.noreply.github.com`,
  };
}

/**
 * The environment a tool-invoked command should see.
 *
 * A command runs because an allowlist permitted it, and an allowlist is a trust
 * decision rather than a sandbox: `npm test` runs whatever the package.json the
 * agent just wrote tells it to, and no blocklist of shell metacharacters changes
 * that. What *can* be changed is what is lying around when it happens.
 *
 * `RIPIENO_*` always goes. Those are the relay and workspace credentials, no command
 * has any use for them, and they were sitting in the environment of every one —
 * which is what made the gate worth defeating in the first place. Holding the
 * workspace token lets a member impersonate the shared workspace and feed the
 * whole room a different codebase.
 *
 * Broader secrets — provider keys, anything ending in TOKEN or SECRET — go only
 * when `unattended`. In a container nobody is watching, so the room could have
 * an agent run `env` and post the output into the transcript. On a member's own
 * machine a human approved this specific command and their environment is
 * theirs; stripping it there would break ordinary work (a test suite that needs
 * a key) to prevent something they were present for.
 */
export function withoutSecrets(env: NodeJS.ProcessEnv, unattended: boolean): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^RIPIENO_/i.test(key)) continue;
    if (unattended && /^(ANTHROPIC|OPENAI|XAI|GROQ|GOOGLE|GEMINI|AWS|GITHUB|GH)_/i.test(key)) continue;
    if (unattended && /(TOKEN|SECRET|PASSWORD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY)$/i.test(key)) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export function capResult(content: string): ToolResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_RESULT_BYTES) {
    return { content };
  }
  const truncated = Buffer.from(content, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return {
    content: `${truncated}\n\n[truncated — output exceeds ${MAX_RESULT_BYTES / 1024}KB]`,
  };
}

/**
 * Is this command covered by an allowlist of prefixes?
 *
 * One implementation, deliberately. The editor and the container each had their
 * own copy, identical down to the regex — the exact duplication `paths.ts` warns
 * about, where a fix lands on one copy and the other keeps the bug.
 *
 * Prefix matching keeps it predictable: "npm test" allows "npm test -- --watch"
 * but never "npm test; rm -rf /", because anything that chains commands is
 * judged as a whole rather than by its first clause.
 *
 * Note what this is not. It is a trust decision, not a sandbox: an allowlisted
 * build tool runs whatever the project files say, and the agent can write those.
 */
export function matchesAllowlist(command: string, allowed: readonly string[]): boolean {
  const trimmed = command.trim();
  if (trimmed === "") return false;
  if (/[;&|`$(){}<>\n]/.test(trimmed)) return false;
  return allowed.some((prefix) => {
    const p = prefix.trim();
    return p.length > 0 && (trimmed === p || trimmed.startsWith(`${p} `));
  });
}

export function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string input "${key}".`);
  }
  return v;
}

export function toInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
