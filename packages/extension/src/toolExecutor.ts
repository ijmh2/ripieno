// Executes ToolCallMsg tools against THIS member's workspace, under this
// user's own OS permissions, and hands back a plain result string.
//
// The tools themselves now live in @ripieno/workspace-core, so a headless container
// can answer exactly the same calls — before that split, the room's shared
// workspace could only ever be somebody's laptop. What remains here is the part
// that genuinely needs an editor: showing a diff before a write, applying it
// through a WorkspaceEdit so Cmd+Z reverses the agent, asking a human about a
// command, and reporting what the member is looking at and what is underlined
// red.
//
// The security boundary moved with the tools. `resolveSafePath` and
// `confineToWorkspace` are imported, never reimplemented — one copy, so a fix
// cannot land on one host and miss the other.

import * as vscode from "vscode";
import * as path from "path";
import { randomUUID } from "crypto";
import { realpath } from "fs/promises";
import type { ToolCallMsg } from "@ripieno/protocol";
import {
  WorkspaceCore,
  capResult,
  matchesAllowlist,
  errText,
  isInside,
  writeProposalConflict,
  staleWriteResult,
  type ApprovalGate,
  type ProgressReporter,
  type Requester,
  type SafePath,
  type ToolResult,
  type WriteProposal,
} from "@ripieno/workspace-core";

export type { ProgressReporter, Requester, ToolResult };

/** Virtual documents holding proposed edits, shown in the diff view. */
const PROPOSED_SCHEME = "mpa-proposed";

export class ToolExecutor {
  private readonly core = new WorkspaceCore({
    resolveRoot: requireWorkspaceRoot,
    gate: new EditorGate(),
  });

  /** Never throws — every failure mode is reported as {content, isError: true}. */
  async execute(
    call: ToolCallMsg,
    report: ProgressReporter = () => {},
    requester?: Requester
  ): Promise<ToolResult> {
    report("received");
    try {
      const handled = await this.core.execute(call.name, call.input, report, requester);
      if (handled) return handled;

      switch (call.name) {
        case "editor_context":
          return await editorContext();
        case "diagnostics":
          return diagnostics();
        default:
          return { content: `Unknown tool "${call.name}".`, isError: true };
      }
    } catch (err) {
      return { content: `Tool "${call.name}" failed: ${errText(err)}`, isError: true };
    }
  }
}

/* ------------------------------------------------------------------ */
/* The editor's answer to "may I?"                                     */
/* ------------------------------------------------------------------ */

class EditorGate implements ApprovalGate {
  async approveCommand(
    command: string,
    requester: Requester | undefined,
    report: ProgressReporter
  ): Promise<boolean> {
    if (isAllowedCommand(command)) return true;

    // Tell the relay a human is now in the loop, so it stops counting down
    // against a machine timeout while somebody reads a dialog.
    report("awaiting-approval");
    const asker = requester
      ? `${requester.label} (@${requester.handle}) wants to run a command in your workspace.`
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
      return true;
    }
    return choice === "Run";
  }

  /**
   * Show the change as a diff and apply it through a WorkspaceEdit.
   *
   * A yes/no modal cannot convey what a write actually does, and writing with
   * `fs.writeFile` would change the file behind the editor's back — no undo, no
   * dirty state. A WorkspaceEdit lands in the normal undo stack, so a member can
   * reverse the agent with Cmd+Z like any other edit.
   */
  async applyWrite(p: WriteProposal): Promise<ToolResult> {
    const requestedTarget = vscode.Uri.file(p.abs);
    const conflict = await writeProposalConflict(p);
    if (conflict) return conflict;
    const original = p.existed ? await vscode.workspace.openTextDocument(requestedTarget) : undefined;
    // VS Code can return an existing model whose URI has different casing or
    // another spelling. Address edits to that model so its version is used.
    const target = original?.uri ?? requestedTarget;
    const aliasConflict = await editorAliasConflict(p, original);
    if (aliasConflict) return aliasConflict;
    const bufferConflict = editorConflict(p, target, original);
    if (bufferConflict) return bufferConflict;
    const originalVersion = original?.version;
    const originalEol = original?.eol;
    // A BOM read from disk is normally encoding metadata, absent from getText.
    // If it is already literal buffer text (e.g. inserted before a reload), keep
    // it literal. Strip only the one marker that this document hides.
    const hidesBom = original && p.expectedContent?.startsWith("\uFEFF") &&
      original.getText() === editorLineEndings(p.expectedContent.slice(1), original.eol);
    const proposedText = hidesBom && p.proposed.startsWith("\uFEFF") ? p.proposed.slice(1) : p.proposed;
    p.report("awaiting-approval");

    // A separate immutable pair per request keeps concurrent previews from
    // replacing one another, and shows exactly the baseline being approved.
    const id = randomUUID();
    const preview = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: p.abs, query: `${id}-proposed` });
    const baseline = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: p.abs, query: `${id}-base` });
    proposedContents.set(preview.toString(), p.proposed);
    proposedContents.set(baseline.toString(), p.expectedContent ?? "");
    proposedChanged.fire(preview);
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        baseline,
        preview,
        `${path.basename(p.abs)} — proposed by the room`,
        { preview: true }
      );
      const who = p.requester ? `${p.requester.label}'s` : "the agent's";
      const choice = await vscode.window.showInformationMessage(
        `Apply ${who} change to ${p.rawPath}?`,
        {
          modal: true,
          detail: p.existed ? "Review the diff before applying." : "This creates a new file.",
        },
        "Apply"
      );
      if (choice !== "Apply") {
        return { content: `The user declined the change to ${p.rawPath}.`, isError: true };
      }

      p.report("running");
      return await serialiseEditorWrite(async () => {
        // Recheck both disk and buffer after approval, inside the write queue.
        // Do not await between the final version check and applyEdit: VS Code
        // then submits the edit against the document version it has observed.
        const aliasConflict = await editorAliasConflict(p, original);
        if (aliasConflict) return aliasConflict;
        const diskConflict = await writeProposalConflict(p);
        if (diskConflict) return diskConflict;
        const bufferConflict = editorConflict(p, target, original, originalVersion);
        if (bufferConflict) return bufferConflict;
        const edit = new vscode.WorkspaceEdit();
        if (original) {
          edit.replace(target, new vscode.Range(0, 0, original.lineCount, 0), proposedText);
        } else {
          // Supported in VS Code 1.85. A single resource operation avoids a
          // create+insert failure leaving an empty file behind.
          edit.createFile(target, {
            contents: Buffer.from(p.proposed, "utf8"), overwrite: false, ignoreIfExists: false,
          });
        }
        if (!(await vscode.workspace.applyEdit(edit))) {
          return { content: `The edit to ${p.rawPath} could not be applied. Read the latest file and retry.`, isError: true };
        }
        // Creation already wrote the exact bytes; do not open and resave them
        // through a potentially different editor encoding or default EOL.
        if (!original) return { content: `Created ${p.rawPath}.` };
        const doc = original;
        // A member can type while the host processes applyEdit. Never silently
        // save that additional work on their behalf.
        if (doc.isClosed || doc.eol !== originalEol ||
            doc.getText() !== editorLineEndings(proposedText, doc.eol)) {
          return { content: `The edit to ${p.rawPath} was applied, but the editor changed again. Review and save it manually.`, isError: true };
        }
        if (!(await doc.save())) {
          return { content: `The edit to ${p.rawPath} was applied in the editor but could not be saved.`, isError: true };
        }
        return { content: `${p.existed ? "Updated" : "Created"} ${p.rawPath}.` };
      });
    } finally {
      proposedContents.delete(preview.toString());
      proposedContents.delete(baseline.toString());
    }
  }
}

/** Shared by all ToolExecutor instances in this extension host. */
let editorWriteQueue: Promise<unknown> = Promise.resolve();
function serialiseEditorWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = editorWriteQueue.then(fn, fn);
  editorWriteQueue = next.then(() => undefined, () => undefined);
  return next;
}

function editorConflict(
  p: WriteProposal,
  target: vscode.Uri,
  original?: vscode.TextDocument,
  version?: number
): ToolResult | undefined {
  const documents = vscode.workspace.textDocuments;
  if (!p.existed) return documents.some((doc) => doc.uri.toString() === target.toString()) ? staleWriteResult(p.rawPath) : undefined;
  if (!original || original.isClosed || !documents.includes(original) ||
      (version !== undefined && original.version !== version)) return staleWriteResult(p.rawPath);
  if (original.isDirty) {
    return { content: `Cannot edit ${p.rawPath}: it has unsaved editor changes. Save or discard them, then read the file and retry.`, isError: true };
  }
  const expected = editorLineEndings(p.expectedContent!, original.eol);
  const actual = original.getText();
  // Keep the raw disk comparison exact. Only the buffer view has normalized
  // line endings and may omit its UTF-8 encoding marker.
  return actual === expected || (expected.startsWith("\uFEFF") && actual === expected.slice(1))
    ? undefined : staleWriteResult(p.rawPath);
}

/** Refuse distinct editor models for one physical file rather than pick a winner. */
async function editorAliasConflict(p: WriteProposal, original?: vscode.TextDocument): Promise<ToolResult | undefined> {
  if (original && path.relative(original.uri.fsPath, p.abs) !== "") {
    try {
      if (path.relative(await realpath(original.uri.fsPath), p.abs) !== "") return staleWriteResult(p.rawPath);
    } catch {
      return staleWriteResult(p.rawPath);
    }
  }
  for (const doc of vscode.workspace.textDocuments) {
    if (doc === original || doc.isClosed || doc.uri.scheme !== "file") continue;
    let abs: string;
    try {
      abs = await realpath(doc.uri.fsPath);
    } catch {
      // A deleted file can still have an unsaved buffer. Resolve its parent so
      // an alias of that buffer also blocks a new-file proposal.
      try { abs = path.join(await realpath(path.dirname(doc.uri.fsPath)), path.basename(doc.uri.fsPath)); }
      catch { continue; }
    }
    if (path.relative(abs, p.abs) === "") {
      return {
        content: `Cannot edit ${p.rawPath}: it is also open under another path. Save any changes and close the other editor document, then read the file and retry.`,
        isError: true,
      };
    }
  }
  return undefined;
}

function editorLineEndings(text: string, eol: vscode.EndOfLine): string {
  return text.replace(/\r\n|\r|\n/g, eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
}

/* ------------------------------------------------------------------ */
/* Editor awareness — no headless equivalent exists                    */
/* ------------------------------------------------------------------ */

/**
 * What the member is actually looking at. A normal in-editor agent knows this;
 * without it the agent has to search the repo for context that was one API
 * call away — the single biggest gap between this and an ordinary assistant.
 */
async function editorContext(): Promise<ToolResult> {
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
function diagnostics(): ToolResult {
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
/* Command allowlist — workspace settings, so it stays per project     */
/* ------------------------------------------------------------------ */

/**
 * Is this command pre-approved?
 *
 * The old all-or-nothing `confirmCommands` is why the tool description had to
 * tell the agent to prefer one big command over several small ones — a prompt
 * working around a missing feature.
 *
 * The matching itself is `matchesAllowlist` in @ripieno/workspace-core. This file
 * used to carry its own copy, identical down to the regex, which is precisely
 * the duplication the path checks are kept in one place to avoid.
 */
function isAllowedCommand(command: string): boolean {
  const config = vscode.workspace.getConfiguration("ripieno");
  const mode = config.get<string>("commandApproval", "always");
  if (mode === "never") return true;
  if (mode !== "allowlist") return false;
  return matchesAllowlist(command, config.get<string[]>("allowedCommands", []));
}

/** Persist an "always allow" choice to workspace settings, not globally. */
async function rememberAllowedCommand(command: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("ripieno");
  const existing = config.get<string[]>("allowedCommands", []);
  const entry = command.trim();
  if (!existing.includes(entry)) {
    await config.update("allowedCommands", [...existing, entry], vscode.ConfigurationTarget.Workspace);
  }
  if (config.get<string>("commandApproval", "always") !== "allowlist") {
    await config.update("commandApproval", "allowlist", vscode.ConfigurationTarget.Workspace);
  }
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function requireWorkspaceRoot(): SafePath {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? { ok: true, abs: root } : { ok: false, reason: "No workspace folder is open." };
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
