// Executes ToolCallMsg tools against THIS member's workspace, under this
// user's own OS permissions, and hands back a plain result string. This is
// the security boundary of the whole product: the agent's tool input is
// untrusted text that arrived over a WebSocket from a relay we don't
// control, so every path is treated as hostile until proven to resolve
// inside the workspace root.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { exec } from "child_process";
import { promisify } from "util";
import type { ToolCallMsg, ToolProgressState } from "@mpa/protocol";
import { COMMAND_TIMEOUT_MS } from "@mpa/protocol";
import { resolveGitApi, Status, type Change } from "./gitApi";

const execAsync = promisify(exec);

const MAX_RESULT_BYTES = 50 * 1024;
const MAX_LIST_RESULTS = 500;
const MAX_SEARCH_MATCHES = 300;
/** Lines returned by read_file when the caller does not ask for a range. */
const DEFAULT_READ_LINES = 2000;
/** Virtual documents holding proposed edits, shown in the diff view. */
const PROPOSED_SCHEME = "mpa-proposed";

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

type SafePath = { ok: true; abs: string } | { ok: false; reason: string };

export class ToolExecutor {
  /** Set per call: whose agent is asking, when it is not this member's own. */
  private requester: Requester | undefined;

  /** Never throws — every failure mode is reported as {content, isError: true}. */
  async execute(
    call: ToolCallMsg,
    report: ProgressReporter = () => {},
    requester?: Requester
  ): Promise<ToolResult> {
    this.requester = requester;
    report("received");
    try {
      switch (call.name) {
        case "read_file":
          return await this.readFile(call.input);
        case "list_files":
          return await this.listFiles(call.input);
        case "search":
          return await this.search(call.input);
        case "git_status":
          return await this.gitStatus();
        case "run_command":
          return await this.runCommand(call.input, report);
        case "write_file":
          return await this.writeFile(call.input, report);
        case "edit_file":
          return await this.editFile(call.input, report);
        case "editor_context":
          return await this.editorContext();
        case "diagnostics":
          return this.diagnostics();
        case "list_dir":
          return await this.listDir(call.input);
        case "stat":
          return await this.stat(call.input);
        default:
          return { content: `Unknown tool "${call.name}".`, isError: true };
      }
    } catch (err) {
      return { content: `Tool "${call.name}" failed: ${errText(err)}`, isError: true };
    }
  }

  /**
   * Read a file, optionally a line range.
   *
   * Without a range a large file was permanently half-readable: it truncated at
   * 50KB with no way to ask for the rest. Line numbers and a total let the agent
   * page through instead of guessing what it missed.
   */
  private async readFile(input: Record<string, unknown>): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const safe = await resolveSafePath(rawPath);
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
      end < total
        ? `\n\n[${total - end} more lines — call again with offset: ${end + 1}]`
        : "";
    return capResult(`${header}\n${numbered}${more}`);
  }

  private async listFiles(input: Record<string, unknown>): Promise<ToolResult> {
    const root = requireWorkspaceRoot();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const dir = typeof input.dir === "string" && input.dir.length > 0 ? input.dir : ".";
    const glob = sanitizeGlob(typeof input.glob === "string" ? input.glob : "**/*");

    const safe = await resolveSafePath(dir);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    const rel = path.relative(root.abs, safe.abs);
    const pattern = new vscode.RelativePattern(root.abs, rel ? `${rel}/${glob}` : glob);
    const found = await vscode.workspace.findFiles(
      pattern,
      "**/{node_modules,.git}/**",
      MAX_LIST_RESULTS
    );
    const uris = await confineToWorkspace(found, root.abs);
    const lines = uris
      .map((u) => path.relative(root.abs, u.fsPath))
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
    const safe = await resolveSafePath(rel);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }

    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(safe.abs));
    } catch (err) {
      return { content: `Cannot read ${rel}: ${errText(err)}`, isError: true };
    }

    const rows: string[] = [];
    for (const [name, type] of entries) {
      // Skipped everywhere else in this file too; listing them would bury the
      // repo in a tree view and make every expand slow.
      if (name === "node_modules" || name === ".git") continue;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      let size = 0;
      if (!isDir) {
        try {
          size = (await vscode.workspace.fs.stat(vscode.Uri.file(path.join(safe.abs, name)))).size;
        } catch {
          // A broken symlink or a race with a delete: report it as empty rather
          // than failing the whole listing.
        }
      }
      rows.push(`${isDir ? "dir" : "file"}\t${size}\t${name}`);
    }
    rows.sort();
    return capResult(rows.join("\n"));
  }

  /** Type, size and mtime for one path — what a provider needs before reading. */
  private async stat(input: Record<string, unknown>): Promise<ToolResult> {
    const rel = requireString(input, "path");
    const safe = await resolveSafePath(rel);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }
    try {
      const info = await vscode.workspace.fs.stat(vscode.Uri.file(safe.abs));
      const kind = (info.type & vscode.FileType.Directory) !== 0 ? "dir" : "file";
      return { content: `${kind}\t${info.size}\t${info.mtime}` };
    } catch (err) {
      return { content: `Cannot stat ${rel}: ${errText(err)}`, isError: true };
    }
  }

  private async search(input: Record<string, unknown>): Promise<ToolResult> {
    const root = requireWorkspaceRoot();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const query = requireString(input, "query");
    const glob = sanitizeGlob(typeof input.glob === "string" ? input.glob : "**/*");

    const pattern = new vscode.RelativePattern(root.abs, glob);
    const found = await vscode.workspace.findFiles(
      pattern,
      "**/{node_modules,.git,dist,out,build}/**",
      2000
    );
    const uris = await confineToWorkspace(found, root.abs);

    const needle = query.toLowerCase();
    const matches: string[] = [];
    for (const uri of uris) {
      if (matches.length >= MAX_SEARCH_MATCHES) {
        break;
      }
      let text: string;
      try {
        text = (await fs.readFile(uri.fsPath)).toString("utf8");
      } catch {
        continue; // binary or unreadable — skip rather than fail the whole search
      }
      const rel = path.relative(root.abs, uri.fsPath);
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_SEARCH_MATCHES; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    return capResult(matches.length > 0 ? matches.join("\n") : "No matches.");
  }

  private async gitStatus(): Promise<ToolResult> {
    const git = await resolveGitApi();
    if (!git) {
      return { content: "Git extension is not available.", isError: true };
    }
    const repo = git.repositories[0];
    if (!repo) {
      return { content: "No git repository is open in this workspace.", isError: true };
    }
    const root = repo.rootUri.fsPath;

    const rows = new Map<string, { index: string; working: string }>();
    const mark = (change: Change, col: "index" | "working", ch: string): void => {
      const rel = path.relative(root, change.uri.fsPath) || ".";
      const row = rows.get(rel) ?? { index: " ", working: " " };
      row[col] = ch;
      rows.set(rel, row);
    };

    for (const c of repo.state.indexChanges) {
      mark(c, "index", indexStatusChar(c.status));
    }
    for (const c of repo.state.workingTreeChanges) {
      if (c.status === Status.UNTRACKED) {
        mark(c, "index", "?");
        mark(c, "working", "?");
      } else {
        mark(c, "working", workingStatusChar(c.status));
      }
    }
    for (const c of repo.state.mergeChanges) {
      mark(c, "index", "U");
      mark(c, "working", "U");
    }

    if (rows.size === 0) {
      return { content: "Working tree clean." };
    }
    const lines = [...rows.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rel, { index, working }]) => `${index}${working} ${rel}`);
    return capResult(lines.join("\n"));
  }

  private async runCommand(
    input: Record<string, unknown>,
    report: ProgressReporter
  ): Promise<ToolResult> {
    const root = requireWorkspaceRoot();
    if (!root.ok) {
      return { content: root.reason, isError: true };
    }
    const command = requireString(input, "command");

    if (!isAllowedCommand(command)) {
      // Tell the relay a human is now in the loop, so it stops counting down
      // against a machine timeout while somebody reads a dialog.
      report("awaiting-approval");
      const asker = this.requester
        ? `${this.requester.label} (@${this.requester.handle}) wants to run a command in your workspace.`
        : "An agent in this room wants to run a command in your workspace.";
      const choice = await vscode.window.showWarningMessage(
        asker,
        { modal: true, detail: command },
        "Run",
        "Always allow this command",
        "Cancel"
      );
      if (choice === "Always allow this command") {
        await rememberAllowedCommand(command);
      } else if (choice !== "Run") {
        return { content: `The user declined to run: ${command}`, isError: true };
      }
    }

    report("running");
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root.abs,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_RESULT_BYTES * 4,
        // A commit made by a remote agent must name that agent, not the member
        // whose machine happened to run it. Without this, provenance quietly
        // collapses into the host's identity the moment work is shared — which
        // is the failure the whole shared-workspace design exists to avoid.
        env: this.commandEnv(),
      });
      const combined = [stdout, stderr].filter(Boolean).join("\n");
      return capResult(combined.length > 0 ? combined : "(command produced no output)");
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      const combined = [e.stdout, e.stderr, e.message].filter(Boolean).join("\n");
      return { ...capResult(combined || "Command failed."), isError: true };
    }
  }

  /**
   * Environment for a command run on this member's behalf.
   *
   * When another member's agent is driving, git authorship follows the agent.
   * The committer stays this machine's user, which is the honest description of
   * what happened: their agent authored it, your machine committed it.
   */
  private commandEnv(): NodeJS.ProcessEnv {
    if (!this.requester) return process.env;
    return {
      ...process.env,
      GIT_AUTHOR_NAME: this.requester.label,
      GIT_AUTHOR_EMAIL: `${this.requester.handle}+agent@users.noreply.github.com`,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Writing                                                           */
  /* ---------------------------------------------------------------- */

  private async writeFile(
    input: Record<string, unknown>,
    report: ProgressReporter
  ): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const content = requireString(input, "content");
    return this.applyProposal(rawPath, content, report);
  }

  /**
   * Replace an exact string. Failing loudly on a non-unique match is deliberate:
   * silently editing the wrong occurrence in someone else's workspace is far
   * worse than making the agent be more specific.
   */
  private async editFile(
    input: Record<string, unknown>,
    report: ProgressReporter
  ): Promise<ToolResult> {
    const rawPath = requireString(input, "path");
    const oldText = requireString(input, "old_text");
    const newText = requireString(input, "new_text");

    const safe = await resolveSafePath(rawPath);
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
    return this.applyProposal(rawPath, current.replace(oldText, newText), report);
  }

  /**
   * Show the change as a diff and apply it through a WorkspaceEdit.
   *
   * A yes/no modal cannot convey what a write actually does, and writing with
   * `fs.writeFile` would change the file behind the editor's back — no undo, no
   * dirty state. A WorkspaceEdit lands in the normal undo stack, so a member can
   * reverse the agent with Cmd+Z like any other edit.
   */
  private async applyProposal(
    rawPath: string,
    proposed: string,
    report: ProgressReporter
  ): Promise<ToolResult> {
    const safe = await resolveSafePath(rawPath);
    if (!safe.ok) {
      return { content: safe.reason, isError: true };
    }

    const target = vscode.Uri.file(safe.abs);
    const existed = await fileExists(safe.abs);
    const current = existed ? (await fs.readFile(safe.abs)).toString("utf8") : "";
    if (existed && current === proposed) {
      return { content: `${rawPath} already has exactly that content; nothing to change.` };
    }

    report("awaiting-approval");
    const preview = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: safe.abs });
    proposedContents.set(preview.toString(), proposed);
    proposedChanged.fire(preview);
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        existed ? target : vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: "/empty" }),
        preview,
        `${path.basename(safe.abs)} — proposed by the room`,
        { preview: true }
      );
      const who = this.requester ? `${this.requester.label}'s` : "the agent's";
      const choice = await vscode.window.showInformationMessage(
        `Apply ${who} change to ${rawPath}?`,
        { modal: true, detail: existed ? "Review the diff before applying." : "This creates a new file." },
        "Apply"
      );
      if (choice !== "Apply") {
        return { content: `The user declined the change to ${rawPath}.`, isError: true };
      }

      report("running");
      const edit = new vscode.WorkspaceEdit();
      if (existed) {
        const doc = await vscode.workspace.openTextDocument(target);
        edit.replace(target, new vscode.Range(0, 0, doc.lineCount, 0), proposed);
      } else {
        edit.createFile(target, { contents: Buffer.from(proposed, "utf8") });
      }
      const applied = await vscode.workspace.applyEdit(edit);
      if (!applied) {
        return { content: `The edit to ${rawPath} could not be applied.`, isError: true };
      }
      const doc = await vscode.workspace.openTextDocument(target);
      await doc.save();
      return { content: `${existed ? "Updated" : "Created"} ${rawPath}.` };
    } finally {
      proposedContents.delete(preview.toString());
    }
  }

  /* ---------------------------------------------------------------- */
  /* Editor awareness                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * What the member is actually looking at. A normal in-editor agent knows this;
   * without it the agent has to search the repo for context that was one API
   * call away — the single biggest gap between this and an ordinary assistant.
   */
  private async editorContext(): Promise<ToolResult> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const lines: string[] = [];

    lines.push(
      folders.length > 0
        ? `Workspace folders:\n${folders.map((f) => `  - ${f.name}: ${f.uri.fsPath}`).join("\n")}`
        : "No workspace folder is open."
    );
    // Say so explicitly rather than quietly ignoring folders 2..n.
    if (folders.length > 1) {
      lines.push(`Note: tools currently operate only on the first folder (${folders[0].name}).`);
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      lines.push("\nNo file is open in the active editor.");
    } else {
      const doc = editor.document;
      const rel = relativeToRoot(doc.uri.fsPath);
      lines.push(`\nActive file: ${rel} (${doc.languageId}, ${doc.lineCount} lines)`);
      lines.push(`Cursor: line ${editor.selection.active.line + 1}`);

      if (!editor.selection.isEmpty) {
        const sel = editor.selection;
        lines.push(
          `Selection: lines ${sel.start.line + 1}-${sel.end.line + 1}\n` +
            "```\n" +
            doc.getText(sel) +
            "\n```"
        );
      }
      const visible = editor.visibleRanges[0];
      if (visible) {
        lines.push(`Visible: lines ${visible.start.line + 1}-${visible.end.line + 1}`);
      }
    }

    const open = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText ? relativeToRoot(t.input.uri.fsPath) : null))
      .filter((p): p is string => p !== null);
    if (open.length > 0) {
      lines.push(`\nOpen editors:\n${[...new Set(open)].map((p) => `  - ${p}`).join("\n")}`);
    }

    return capResult(lines.join("\n"));
  }

  /** Everything the Problems panel knows, which the agent otherwise cannot see. */
  private diagnostics(): ToolResult {
    const root = requireWorkspaceRoot();
    const rows: string[] = [];

    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (root.ok && !isInside(uri.fsPath, root.abs)) continue;
      for (const d of diags) {
        rows.push(
          `${relativeToRoot(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
            `${severityName(d.severity)}: ${d.message}${d.source ? ` (${d.source})` : ""}`
        );
      }
    }
    if (rows.length === 0) {
      return { content: "No diagnostics reported in the workspace." };
    }
    rows.sort();
    return capResult(`${rows.length} diagnostic(s):\n${rows.join("\n")}`);
  }
}

/* ------------------------------------------------------------------ */
/* Proposed-edit documents                                             */
/* ------------------------------------------------------------------ */

const proposedContents = new Map<string, string>();
const proposedChanged = new vscode.EventEmitter<vscode.Uri>();

/**
 * Backs the right-hand side of the diff. Registered once at activation; holds
 * only in-memory proposals, so nothing is written until the member approves.
 */
export function registerProposedDocuments(): vscode.Disposable {
  return vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, {
    onDidChange: proposedChanged.event,
    provideTextDocumentContent: (uri) => proposedContents.get(uri.toString()) ?? "",
  });
}

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/**
 * Is this command pre-approved?
 *
 * The old all-or-nothing `confirmCommands` is why the tool description had to
 * tell the agent to prefer one big command over several small ones — a prompt
 * working around a missing feature. Prefix matching keeps it predictable:
 * "npm test" allows "npm test -- --watch" but never "npm test; rm -rf /",
 * because a shell separator ends the comparable prefix.
 */
function isAllowedCommand(command: string): boolean {
  const config = vscode.workspace.getConfiguration("mpa");
  const mode = config.get<string>("commandApproval", "always");
  if (mode === "never") return true;
  if (mode !== "allowlist") return false;

  const trimmed = command.trim();
  // Anything chaining commands is judged as a whole, never by its first clause.
  if (/[;&|`$(){}<>\n]/.test(trimmed)) return false;

  return config
    .get<string[]>("allowedCommands", [])
    .some((prefix) => {
      const p = prefix.trim();
      return p.length > 0 && (trimmed === p || trimmed.startsWith(`${p} `));
    });
}

/** Persist an "always allow" choice to workspace settings, not globally. */
async function rememberAllowedCommand(command: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("mpa");
  const existing = config.get<string[]>("allowedCommands", []);
  const entry = command.trim();
  if (!existing.includes(entry)) {
    await config.update(
      "allowedCommands",
      [...existing, entry],
      vscode.ConfigurationTarget.Workspace
    );
  }
  if (config.get<string>("commandApproval", "always") !== "allowlist") {
    await config.update("commandApproval", "allowlist", vscode.ConfigurationTarget.Workspace);
  }
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

function relativeToRoot(abs: string): string {
  const root = requireWorkspaceRoot();
  return root.ok ? path.relative(root.abs, abs) || path.basename(abs) : abs;
}

function severityName(severity: vscode.DiagnosticSeverity): string {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

function requireWorkspaceRoot(): SafePath {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? { ok: true, abs: root } : { ok: false, reason: "No workspace folder is open." };
}

/**
 * Resolve an untrusted relative path against the workspace root, rejecting
 * ".." / absolute escapes syntactically, then rejecting symlink escapes by
 * comparing real paths for anything that actually exists on disk.
 */
/**
 * Keep only the results that really live inside the workspace.
 *
 * `findFiles` follows symlinks, so a link inside the workspace (a `vendor` dir
 * pointing at $HOME, a monorepo link) yields paths that are *syntactically*
 * under the root while resolving outside it. Only realpath catches that, and
 * the check has to happen before we read anything — reading is the leak.
 *
 * One realpath per distinct directory rather than per file, so a 2000-file
 * search stays cheap.
 */
async function confineToWorkspace(uris: vscode.Uri[], rootAbs: string): Promise<vscode.Uri[]> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootAbs);
  } catch {
    return [];
  }

  const verdicts = new Map<string, boolean>();
  const kept: vscode.Uri[] = [];
  for (const uri of uris) {
    const dir = path.dirname(uri.fsPath);
    let ok = verdicts.get(dir);
    if (ok === undefined) {
      try {
        ok = isInside(await fs.realpath(dir), realRoot);
      } catch {
        ok = false;
      }
      verdicts.set(dir, ok);
    }
    if (ok) {
      kept.push(uri);
    }
  }
  return kept;
}

async function resolveSafePath(rawPath: string): Promise<SafePath> {
  const root = requireWorkspaceRoot();
  if (!root.ok) {
    return root;
  }

  const resolved = path.resolve(root.abs, rawPath);
  if (!isInside(resolved, root.abs)) {
    return { ok: false, reason: `Path "${rawPath}" is outside the workspace.` };
  }

  try {
    const [realRoot, realResolved] = await Promise.all([
      fs.realpath(root.abs),
      fs.realpath(resolved),
    ]);
    if (!isInside(realResolved, realRoot)) {
      return { ok: false, reason: `Path "${rawPath}" escapes the workspace via a symlink.` };
    }
  } catch {
    // Target (or a path segment) doesn't exist yet — the syntactic check
    // above already ruled out escape, so let the caller's fs op surface
    // ENOENT naturally.
  }

  return { ok: true, abs: resolved };
}

function isInside(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(withSep);
}

/** Defense in depth: findFiles is already scoped to its base, but strip any
 *  ".." segments so a crafted glob can't be used to climb out. */
function sanitizeGlob(glob: string): string {
  const cleaned = glob
    .split("/")
    .filter((seg) => seg !== "..")
    .join("/");
  return cleaned.length > 0 ? cleaned : "**/*";
}

/* ------------------------------------------------------------------ */
/* Misc helpers                                                        */
/* ------------------------------------------------------------------ */

function requireString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Missing required string input "${key}".`);
  }
  return v;
}

function capResult(content: string): ToolResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_RESULT_BYTES) {
    return { content };
  }
  const truncated = Buffer.from(content, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
  return {
    content: `${truncated}\n\n[truncated — output exceeds ${MAX_RESULT_BYTES / 1024}KB]`,
  };
}

function indexStatusChar(s: Status): string {
  switch (s) {
    case Status.INDEX_ADDED:
      return "A";
    case Status.INDEX_DELETED:
      return "D";
    case Status.INDEX_RENAMED:
      return "R";
    case Status.INDEX_COPIED:
      return "C";
    default:
      return "M";
  }
}

function workingStatusChar(s: Status): string {
  switch (s) {
    case Status.DELETED:
      return "D";
    case Status.TYPE_CHANGED:
      return "T";
    default:
      return "M";
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
