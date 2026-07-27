// Executes ToolCallMsg tools against THIS member's workspace, under this
// user's own OS permissions, and hands back a plain result string.
//
// The tools themselves now live in @mpa/workspace-core, so a headless container
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
import type { ToolCallMsg } from "@mpa/protocol";
import {
  WorkspaceCore,
  capResult,
  errText,
  isInside,
  type ApprovalGate,
  type ProgressReporter,
  type Requester,
  type SafePath,
  type ToolResult,
  type WriteProposal,
} from "@mpa/workspace-core";

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
    const target = vscode.Uri.file(p.abs);
    p.report("awaiting-approval");

    const preview = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: p.abs });
    proposedContents.set(preview.toString(), p.proposed);
    proposedChanged.fire(preview);
    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        p.existed ? target : vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: "/empty" }),
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
      const edit = new vscode.WorkspaceEdit();
      if (p.existed) {
        const doc = await vscode.workspace.openTextDocument(target);
        edit.replace(target, new vscode.Range(0, 0, doc.lineCount, 0), p.proposed);
      } else {
        edit.createFile(target, { contents: Buffer.from(p.proposed, "utf8") });
      }
      if (!(await vscode.workspace.applyEdit(edit))) {
        return { content: `The edit to ${p.rawPath} could not be applied.`, isError: true };
      }
      const doc = await vscode.workspace.openTextDocument(target);
      await doc.save();
      return { content: `${p.existed ? "Updated" : "Created"} ${p.rawPath}.` };
    } finally {
      proposedContents.delete(preview.toString());
    }
  }
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

  return config.get<string[]>("allowedCommands", []).some((prefix) => {
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
