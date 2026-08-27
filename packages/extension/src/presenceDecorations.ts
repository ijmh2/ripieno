import * as vscode from "vscode";
import type { AgentPresence, AttachedAgent, RosterEntry } from "@ripieno/protocol";

export interface PresenceDecorationSource {
  member: RosterEntry;
  agent: AttachedAgent;
  presence: AgentPresence;
  uri: vscode.Uri;
}

export type PresenceUriResolver = (
  member: RosterEntry,
  agent: AttachedAgent,
  presence: AgentPresence
) => vscode.Uri | undefined;

const MEMBER_HUES = [356, 27, 45, 142, 174, 207, 262, 322] as const;

/** Convert a 1-based, inclusive provider range into an editor range. */
export function presenceRange(
  line: number | undefined,
  endLine: number | undefined,
  lineCount: number
): vscode.Range | undefined {
  if (!Number.isSafeInteger(line) || !line || line < 1 || lineCount < 1) return undefined;
  const start = Math.min(line, lineCount) - 1;
  const boundedEnd =
    Number.isSafeInteger(endLine) && endLine! >= line ? Math.min(endLine!, lineCount) - 1 : start;
  return new vscode.Range(start, 0, boundedEnd, Number.MAX_SAFE_INTEGER);
}

/**
 * Paint honest working ranges in already-open editors.
 *
 * This deliberately does not simulate a Google-Docs caret. Coding agents
 * apply tools and patches atomically, so the defensible signal is a coloured
 * active range. Roster snapshots are authoritative: idle/detached/stale agents
 * disappear on the next update and their decorations are cleared immediately.
 */
export class PresenceDecorations implements vscode.Disposable {
  private roster: RosterEntry[] = [];
  private readonly invalidatedSharedPaths = new Map<string, number>();
  private readonly decorationTypes: vscode.TextEditorDecorationType[];
  private readonly visibleEditorsListener: vscode.Disposable;

  constructor(private readonly resolveUri: PresenceUriResolver) {
    this.decorationTypes = MEMBER_HUES.map((hue) =>
      vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: `hsla(${hue}, 70%, 50%, 0.10)`,
        borderStyle: "solid",
        borderWidth: "0 0 0 3px",
        borderColor: `hsl(${hue}, 70%, 50%)`,
        overviewRulerColor: `hsl(${hue}, 70%, 50%)`,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      })
    );
    this.visibleEditorsListener = vscode.window.onDidChangeVisibleTextEditors(() => this.refresh());
  }

  update(roster: RosterEntry[]): void {
    this.roster = roster;
    this.pruneInvalidations();
    this.refresh();
  }

  /** Hide a shared range until that agent reports a newer observation. */
  invalidateSharedPath(path: string, at = Date.now()): void {
    if (!path) return;
    this.invalidatedSharedPaths.set(path, at);
    this.refresh();
  }

  isCurrent(presence: AgentPresence): boolean {
    return !(
      presence.path &&
      presence.locationScope === "shared" &&
      (this.invalidatedSharedPaths.get(presence.path) ?? 0) >= presence.updatedAt
    );
  }

  refresh(): void {
    const visible = vscode.window.visibleTextEditors;
    const options = new Map<
      vscode.TextEditor,
      vscode.DecorationOptions[][]
    >();
    for (const editor of visible) {
      options.set(editor, MEMBER_HUES.map(() => []));
    }

    for (const member of this.roster) {
      for (const agent of member.agents ?? []) {
        const presence = agent.activity;
        if (!presence?.path || presence.phase === "idle") continue;
        if (!this.isCurrent(presence)) continue;
        const uri = this.resolveUri(member, agent, presence);
        if (!uri) continue;
        const editor = visible.find((candidate) => sameUri(candidate.document.uri, uri));
        if (!editor) continue;
        const range = presenceRange(presence.line, presence.endLine, editor.document.lineCount);
        if (!range) continue;
        const hoverMessage = new vscode.MarkdownString(
          `**${agent.label}** · @${member.handle}\n\n${presence.summary ?? presence.phase}`
        );
        hoverMessage.isTrusted = false;
        options.get(editor)![member.color % MEMBER_HUES.length].push({ range, hoverMessage });
      }
    }
    for (const [editor, byColor] of options) {
      byColor.forEach((entries, color) =>
        editor.setDecorations(this.decorationTypes[color], entries)
      );
    }
  }

  dispose(): void {
    this.visibleEditorsListener.dispose();
    for (const decorationType of this.decorationTypes) decorationType.dispose();
  }

  private pruneInvalidations(): void {
    const oldestLiveShared = new Map<string, number>();
    for (const member of this.roster) {
      for (const agent of member.agents ?? []) {
        const presence = agent.activity;
        if (presence?.path && presence.locationScope === "shared") {
          oldestLiveShared.set(
            presence.path,
            Math.min(oldestLiveShared.get(presence.path) ?? Number.MAX_SAFE_INTEGER, presence.updatedAt)
          );
        }
      }
    }
    for (const [path, invalidatedAt] of this.invalidatedSharedPaths) {
      const observedAt = oldestLiveShared.get(path);
      if (observedAt === undefined || observedAt > invalidatedAt) {
        this.invalidatedSharedPaths.delete(path);
      }
    }
  }
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}
