// WebviewViewProvider for the "ripieno.room" view. Owns the webview's HTML and
// is the single source of truth for room state on the extension-host side,
// so the view can be torn down and recreated (VS Code disposes hidden
// webviews' DOM but keeps this provider alive) without losing history:
// instead of `retainContextWhenHidden` (which keeps a whole hidden webview
// process around) we just resend a full snapshot on visibility change.

import * as vscode from "vscode";
import type { ActionEntry, RoomMode, RoomStatus, RosterEntry, TranscriptEntry } from "@ripieno/protocol";
import type { ConnectionState } from "@ripieno/relay-client";
import type { ApprovalChoice } from "./approvals";
import { onboardingCommandFor, parseRoomViewMessage } from "./roomViewMessages";

interface RoomState {
  room?: string;
  /** Which driver runs this room. Shown so a room can never lie about it. */
  mode?: RoomMode;
  you?: RosterEntry;
  roster: RosterEntry[];
  transcript: TranscriptEntry[];
  /** What agents have *done*, kept apart from what people have said. */
  actions: ActionEntry[];
  /** entryId -> accumulated streamed text, cleared once the final entry lands. */
  liveDeltas: Map<string, string>;
  status: RoomStatus;
  waitingOn?: string;
  connection: ConnectionState;
}

interface PendingApproval {
  id: string;
  agentLabel: string;
  toolName: string;
  summary: string;
  rememberable: boolean;
}

function emptyState(connection: ConnectionState): RoomState {
  return { roster: [], transcript: [], actions: [], liveDeltas: new Map(), status: "idle", connection };
}

/** Messages the extension host pushes into the webview. */
type ToWebview =
  | {
      type: "snapshot";
      room?: string;
      mode?: RoomMode;
      you?: RosterEntry;
      roster: RosterEntry[];
      transcript: TranscriptEntry[];
  /** What agents have *done*, kept apart from what people have said. */
  actions: ActionEntry[];
      liveDeltas: [string, string][];
      status: RoomStatus;
      waitingOn?: string;
      connection: ConnectionState;
      approvals: PendingApproval[];
    }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "action"; entry: ActionEntry }
  | { type: "delta"; entryId: string; text: string }
  | { type: "deltaCancel"; entryId: string }
  | { type: "roster"; roster: RosterEntry[]; you?: RosterEntry }
  | { type: "status"; status: RoomStatus; waitingOn?: string }
  | { type: "connection"; state: ConnectionState }
  | {
      type: "approval";
      id: string;
      agentLabel: string;
      toolName: string;
      summary: string;
      rememberable: boolean;
    };

export class RoomViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "ripieno.room";

  private view: vscode.WebviewView | undefined;
  private state: RoomState = emptyState("offline");
  /** Approval cards awaiting an answer from the webview. */
  private readonly pendingApprovals = new Map<
    string,
    { request: PendingApproval; resolve: (choice: ApprovalChoice | undefined) => void }
  >();
  private nextApprovalId = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onComposerSend: (text: string) => void
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      const msg = parseRoomViewMessage(raw);
      if (!msg) return;

      if (msg.type === "ready") {
        this.postSnapshot();
      } else if (msg.type === "send") {
        this.onComposerSend(msg.text);
      } else if (msg.type === "approvalVerdict") {
        const pending = this.pendingApprovals.get(msg.id);
        if (!pending) return;
        pending.resolve(msg.choice);
        this.pendingApprovals.delete(msg.id);
      } else if (msg.type === "onboardingAction") {
        const command = onboardingCommandFor(msg.action, this.state);
        if (command) void vscode.commands.executeCommand(command);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postSnapshot();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        this.resolvePendingApprovals();
      }
    });
  }

  /* -------------------------------------------------------------- */
  /* Called by extension.ts as ServerMsg / connection events arrive  */
  /* -------------------------------------------------------------- */

  setJoined(
    room: string,
    you: RosterEntry,
    roster: RosterEntry[],
    transcript: TranscriptEntry[],
    mode: RoomMode,
    actions: ActionEntry[] = []
  ): void {
    this.state = {
      room,
      mode,
      actions,
      you,
      roster,
      transcript: [...transcript],
      liveDeltas: new Map(),
      status: "idle",
      waitingOn: undefined,
      connection: this.state.connection,
    };
    this.postSnapshot();
  }

  /** Work done by an agent, shown apart from the conversation. */
  addAction(entry: ActionEntry): void {
    this.state.actions.push(entry);
    this.post({ type: "action", entry });
  }

  setRoster(roster: RosterEntry[]): void {
    this.state.roster = roster;
    const youHandle = this.state.you?.handle;
    this.state.you = youHandle ? roster.find((member) => member.handle === youHandle) : undefined;
    this.post({ type: "roster", roster, you: this.state.you });
  }

  addEntry(entry: TranscriptEntry): void {
    this.state.transcript.push(entry);
    this.state.liveDeltas.delete(entry.id);
    this.post({ type: "entry", entry });
  }

  addDelta(entryId: string, text: string): void {
    const acc = (this.state.liveDeltas.get(entryId) ?? "") + text;
    this.state.liveDeltas.set(entryId, acc);
    this.post({ type: "delta", entryId, text });
  }

  /**
   * Drop a preview that never became a message. Keeping it would leave text on
   * screen that is in no transcript, so this view and a freshly-loaded one would
   * disagree about what the agent said.
   */
  cancelDelta(entryId: string): void {
    this.state.liveDeltas.delete(entryId);
    this.post({ type: "deltaCancel", entryId });
  }

  setStatus(status: RoomStatus, waitingOn?: string): void {
    this.state.status = status;
    this.state.waitingOn = waitingOn;
    this.post({ type: "status", status, waitingOn });
  }

  setConnection(connection: ConnectionState): void {
    this.state.connection = connection;
    this.post({ type: "connection", state: connection });
  }

  /**
   * Show a permission request inline, above the composer, and resolve with the
   * member's answer. Returns undefined when there is no live webview to ask —
   * the caller then falls back to a modal rather than leaving the agent hanging
   * on a question nobody was shown.
   */
  requestApproval(request: {
    agentLabel: string;
    toolName: string;
    summary: string;
    rememberable: boolean;
  }): Promise<ApprovalChoice | undefined> {
    const view = this.view;
    if (!view?.visible) {
      return Promise.resolve(undefined);
    }
    const id = `ap_${this.nextApprovalId++}`;
    const pending: PendingApproval = { id, ...request };
    return new Promise<ApprovalChoice | undefined>((resolve) => {
      this.pendingApprovals.set(id, { request: pending, resolve });
      void view.webview.postMessage({ type: "approval", ...pending }).then((delivered) => {
        const current = this.pendingApprovals.get(id);
        if (!delivered && current) {
          this.pendingApprovals.delete(id);
          current.resolve(undefined);
        }
      });
      // If the view is hidden or reloaded before an answer arrives, the card is
      // gone; give up so the modal can take over instead of stalling.
      const check = setInterval(() => {
        if (!this.view?.visible && this.pendingApprovals.has(id)) {
          clearInterval(check);
          this.pendingApprovals.delete(id);
          resolve(undefined);
        } else if (!this.pendingApprovals.has(id)) {
          clearInterval(check);
        }
      }, 1000);
    });
  }

  /** Called on ripieno.leaveRoom: clears the transcript and returns to idle. */
  reset(): void {
    this.resolvePendingApprovals();
    this.state = emptyState("offline");
    this.postSnapshot();
  }

  private resolvePendingApprovals(): void {
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(undefined);
    }
    this.pendingApprovals.clear();
  }

  private post(msg: ToWebview): void {
    void this.view?.webview.postMessage(msg);
  }

  private postSnapshot(): void {
    this.post({
      type: "snapshot",
      room: this.state.room,
      mode: this.state.mode,
      you: this.state.you,
      roster: this.state.roster,
      transcript: this.state.transcript,
      actions: this.state.actions,
      liveDeltas: [...this.state.liveDeltas.entries()],
      status: this.state.status,
      waitingOn: this.state.waitingOn,
      connection: this.state.connection,
      approvals: [...this.pendingApprovals.values()].map(({ request }) => request),
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const csp = nonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js")
    );

    // No img-src / connect-src: avatars render as coloured initials, not
    // remote images, and the webview never talks to the network directly —
    // all relay traffic goes through the extension host.
    const cspHeader = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${csp}'`,
      "font-src 'none'",
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${cspHeader}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>Ripieno</title>
</head>
<body>
<header id="header" class="header">
  <div class="room-meta">
    <div id="roomLabel" class="room-label">Not connected</div>
    <span id="modeBadge" class="mode-badge" hidden></span>
  </div>
  <div id="statusPill" class="status-pill idle" role="status" aria-live="polite">idle</div>
  <div id="roster" class="roster" role="list" aria-label="People in this room"></div>
</header>
<div class="transcript-wrap">
  <div id="transcript" class="transcript" role="log" aria-live="polite" aria-label="Room conversation"></div>
  <button id="jumpLatest" class="jump-latest" type="button" hidden>Latest <span aria-hidden="true">↓</span></button>
</div>
<details id="actions" class="actions" hidden>
  <summary id="actionsSummary" class="actions-summary">Work</summary>
  <div id="actionsList" class="actions-list"></div>
</details>
<div id="approvalStack" class="approval-stack" aria-live="assertive"></div>
<div id="composerValidation" class="composer-validation" role="alert" hidden></div>
<div id="composerBar" class="composer-bar">
  <div id="mentions" class="mentions" role="listbox" aria-label="Message suggestions" hidden></div>
  <textarea id="composer" class="composer" rows="1" aria-label="Message the room" aria-controls="mentions" aria-describedby="composerValidation" aria-expanded="false" aria-autocomplete="list" placeholder="Message the room…"></textarea>
  <button id="sendButton" class="send-button" type="button">Send</button>
</div>
<script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
