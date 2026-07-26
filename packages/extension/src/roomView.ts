// WebviewViewProvider for the "mpa.room" view. Owns the webview's HTML and
// is the single source of truth for room state on the extension-host side,
// so the view can be torn down and recreated (VS Code disposes hidden
// webviews' DOM but keeps this provider alive) without losing history:
// instead of `retainContextWhenHidden` (which keeps a whole hidden webview
// process around) we just resend a full snapshot on visibility change.

import * as vscode from "vscode";
import type { RoomMode, RoomStatus, RosterEntry, TranscriptEntry } from "@mpa/protocol";
import type { ConnectionState } from "./relayClient";
import type { ApprovalChoice } from "./approvals";

interface RoomState {
  room?: string;
  /** Which driver runs this room. Shown so a room can never lie about it. */
  mode?: RoomMode;
  you?: RosterEntry;
  roster: RosterEntry[];
  transcript: TranscriptEntry[];
  /** entryId -> accumulated streamed text, cleared once the final entry lands. */
  liveDeltas: Map<string, string>;
  status: RoomStatus;
  waitingOn?: string;
  connection: ConnectionState;
}

function emptyState(connection: ConnectionState): RoomState {
  return { roster: [], transcript: [], liveDeltas: new Map(), status: "idle", connection };
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
      liveDeltas: [string, string][];
      status: RoomStatus;
      waitingOn?: string;
      connection: ConnectionState;
    }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "delta"; entryId: string; text: string }
  | { type: "deltaCancel"; entryId: string }
  | { type: "roster"; roster: RosterEntry[] }
  | { type: "status"; status: RoomStatus; waitingOn?: string }
  | { type: "connection"; state: ConnectionState }
  | {
      type: "approval";
      id: string;
      agentLabel: string;
      toolName: string;
      summary: string;
    };

/** Messages the webview's composer sends back to the extension host. */
type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "approvalVerdict"; id: string; choice: ApprovalChoice };

export class RoomViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "mpa.room";

  private view: vscode.WebviewView | undefined;
  private state: RoomState = emptyState("offline");
  /** Approval cards awaiting an answer from the webview. */
  private readonly pendingApprovals = new Map<string, (choice: ApprovalChoice) => void>();
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

    webviewView.webview.onDidReceiveMessage((msg: FromWebview) => {
      if (msg.type === "ready") {
        this.postSnapshot();
      } else if (msg.type === "send") {
        this.onComposerSend(msg.text);
      } else if (msg.type === "approvalVerdict") {
        this.pendingApprovals.get(msg.id)?.(msg.choice);
        this.pendingApprovals.delete(msg.id);
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postSnapshot();
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
    mode: RoomMode
  ): void {
    this.state = {
      room,
      mode,
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

  setRoster(roster: RosterEntry[]): void {
    this.state.roster = roster;
    this.post({ type: "roster", roster });
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
  }): Promise<ApprovalChoice | undefined> {
    if (!this.view?.visible) {
      return Promise.resolve(undefined);
    }
    const id = `ap_${this.nextApprovalId++}`;
    return new Promise<ApprovalChoice | undefined>((resolve) => {
      this.pendingApprovals.set(id, resolve);
      this.post({ type: "approval", id, ...request });
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

  /** Called on mpa.leaveRoom: clears the transcript and returns to idle. */
  reset(): void {
    this.state = emptyState(this.state.connection);
    this.postSnapshot();
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
      liveDeltas: [...this.state.liveDeltas.entries()],
      status: this.state.status,
      waitingOn: this.state.waitingOn,
      connection: this.state.connection,
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
<title>Multiplayer Agent</title>
</head>
<body>
<div id="header" class="header">
  <div id="roomLabel" class="room-label">Not connected</div>
  <div id="roster" class="roster"></div>
  <div id="statusPill" class="status-pill idle">idle</div>
</div>
<div id="transcript" class="transcript" role="log" aria-live="polite"></div>
<div id="composerBar" class="composer-bar">
  <textarea id="composer" class="composer" rows="1" placeholder="Message the room…"></textarea>
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
