// WebviewViewProvider for the "ripieno.room" view. Owns the webview's HTML and
// is the single source of truth for room state on the extension-host side,
// so the view can be torn down and recreated (VS Code disposes hidden
// webviews' DOM but keeps this provider alive) without losing history:
// instead of `retainContextWhenHidden` (which keeps a whole hidden webview
// process around) we just resend a full snapshot on visibility change.

import * as vscode from "vscode";
import type {
  ActionEntry,
  AgentDraft,
  AgentUsage,
  ContextAuditEntry,
  ContextItem,
  ContextKind,
  Goal,
  GoalAuditEntry,
  HandoffAuditEntry,
  HandoffDecision,
  HandoffOffer,
  RoomMode,
  RoomStatus,
  RosterEntry,
  TranscriptEntry,
} from "@ripieno/protocol";
import type { ConnectionState } from "@ripieno/relay-client";
import type { ApprovalChoice } from "./approvals";
import { onboardingCommandFor, parseRoomViewMessage } from "./roomViewMessages";
import { applyGoalState } from "./goalState";
import { applyHandoffState } from "./handoffState";
import {
  decideOnboarding,
  type OnboardingAgentState,
  type OnboardingDecision,
} from "./agentSetup";
import {
  buildRoomPanelSnapshot,
  type LocalAgentPanelDetail,
} from "./roomPanelState";

export interface LocalAgentOnboarding extends LocalAgentPanelDetail {
  state: OnboardingAgentState;
}

interface RoomState {
  room?: string;
  workspaceHost?: string;
  /** Local display name only; never relayed to another member. */
  localWorkspaceFolder?: string;
  /** Which driver runs this room. Shown so a room can never lie about it. */
  mode?: RoomMode;
  you?: RosterEntry;
  roster: RosterEntry[];
  transcript: TranscriptEntry[];
  /** What agents have *done*, kept apart from what people have said. */
  actions: ActionEntry[];
  goals: Goal[];
  goalAudit: GoalAuditEntry[];
  roomRevision: number;
  context: ContextItem[];
  contextAudit: ContextAuditEntry[];
  contextRevision: number;
  handoffs: HandoffOffer[];
  handoffAudit: HandoffAuditEntry[];
  handoffRevision: number;
  /** Configured on this machine, including agents not attached to the room. */
  localAgents: LocalAgentOnboarding[];
  usage: AgentUsage[];
  /** entryId -> relay-attributed preview, cleared once the final entry lands. */
  liveDeltas: Map<string, LiveDelta>;
  status: RoomStatus;
  waitingOn?: string;
  connection: ConnectionState;
}

type LiveDelta = Pick<AgentDraft, "entryId" | "text"> & {
  agentId?: string;
  authorHandle?: string;
  authorName?: string;
  updatedAt?: number;
};

interface PendingApproval {
  id: string;
  agentLabel: string;
  toolName: string;
  summary: string;
  rememberable: boolean;
}

function emptyState(connection: ConnectionState): RoomState {
  return {
    roster: [],
    transcript: [],
    actions: [],
    goals: [],
    goalAudit: [],
    roomRevision: 0,
    context: [],
    contextAudit: [],
    contextRevision: 0,
    handoffs: [],
    handoffAudit: [],
    handoffRevision: 0,
    localAgents: [],
    usage: [],
    liveDeltas: new Map(),
    status: "idle",
    connection,
  };
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
      goals: Goal[];
      goalAudit: GoalAuditEntry[];
      roomRevision: number;
      context: ContextItem[];
      contextAudit: ContextAuditEntry[];
      contextRevision: number;
      handoffs: HandoffOffer[];
      handoffAudit: HandoffAuditEntry[];
      handoffRevision: number;
      onboarding: OnboardingDecision;
      liveDeltas: LiveDelta[];
      status: RoomStatus;
      waitingOn?: string;
      connection: ConnectionState;
      approvals: PendingApproval[];
    }
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "action"; entry: ActionEntry }
  | { type: "goals"; goals: Goal[]; goalAudit: GoalAuditEntry[]; roomRevision: number }
  | {
      type: "context";
      context: ContextItem[];
      contextAudit: ContextAuditEntry[];
      contextRevision: number;
    }
  | {
      type: "handoffs";
      handoffs: HandoffOffer[];
      handoffAudit: HandoffAuditEntry[];
      handoffRevision: number;
    }
  | {
      type: "delta";
      entryId: string;
      text: string;
      agentId?: string;
      authorHandle?: string;
      authorName?: string;
    }
  | { type: "deltaCancel"; entryId: string }
  | { type: "roster"; roster: RosterEntry[]; you?: RosterEntry; onboarding: OnboardingDecision }
  | { type: "onboarding"; onboarding: OnboardingDecision }
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
  private roomPanel: vscode.WebviewPanel | undefined;
  private state: RoomState = emptyState("offline");
  /** Approval cards awaiting an answer from the webview. */
  private readonly pendingApprovals = new Map<
    string,
    { request: PendingApproval; resolve: (choice: ApprovalChoice | undefined) => void }
  >();
  private nextApprovalId = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onComposerSend: (text: string) => void,
    private readonly onContextCreate: (request: {
      kind: ContextKind;
      title: string;
      body: string;
      tags: string[];
    }) => void,
    private readonly onContextStatus: (request: {
      id: string;
      expectedVersion: number;
      status: "accepted" | "superseded" | "archived";
    }) => void,
    private readonly onHandoffAction: (request: {
      action: HandoffDecision;
      id: string;
      expectedVersion: number;
      targetAgentId?: string;
    }) => void,
    private readonly onOpenAgentLocation: (agentId: string) => void
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
      } else if (msg.type === "contextCreate") {
        this.onContextCreate(msg);
      } else if (msg.type === "contextStatus") {
        this.onContextStatus(msg);
      } else if (msg.type === "approvalVerdict") {
        const pending = this.pendingApprovals.get(msg.id);
        if (!pending) return;
        pending.resolve(msg.choice);
        this.pendingApprovals.delete(msg.id);
      } else if (msg.type === "handoffAction") {
        this.onHandoffAction({
          action: msg.action,
          id: msg.id,
          expectedVersion: msg.expectedVersion,
          targetAgentId: msg.targetAgentId,
        });
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

  /** Open (or reveal) the editor-sized Room overview and exact-agent tabs. */
  openRoomPanel(): void {
    if (this.roomPanel) {
      this.roomPanel.reveal(this.roomPanel.viewColumn, true);
      this.postRoomPanelSnapshot();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "ripieno.roomPanel",
      this.state.room ? `Ripieno · ${this.state.room}` : "Ripieno Room",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      }
    );
    this.roomPanel = panel;
    panel.webview.html = this.renderRoomPanelHtml(panel.webview);
    panel.webview.onDidReceiveMessage((value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        (value as { type?: unknown }).type === "panelReady"
      ) {
        this.postRoomPanelSnapshot();
      } else if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 2 &&
        (value as { type?: unknown }).type === "openAgentLocation" &&
        typeof (value as { agentId?: unknown }).agentId === "string" &&
        (value as { agentId: string }).agentId.length <= 300
      ) {
        this.onOpenAgentLocation((value as { agentId: string }).agentId);
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.visible) this.postRoomPanelSnapshot();
    });
    panel.onDidDispose(() => {
      if (this.roomPanel === panel) this.roomPanel = undefined;
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
    actions: ActionEntry[] = [],
    goals: Goal[] = [],
    goalAudit: GoalAuditEntry[] = [],
    roomRevision = 0,
    context: ContextItem[] = [],
    contextAudit: ContextAuditEntry[] = [],
    contextRevision = 0,
    handoffs: HandoffOffer[] = [],
    handoffAudit: HandoffAuditEntry[] = [],
    handoffRevision = 0,
    drafts: AgentDraft[] = [],
    usage: AgentUsage[] = [],
    workspaceHost?: string,
    localWorkspaceFolder?: string
  ): void {
    this.state = {
      room,
      workspaceHost,
      localWorkspaceFolder,
      mode,
      actions,
      goals,
      goalAudit,
      roomRevision,
      context,
      contextAudit,
      contextRevision,
      handoffs,
      handoffAudit,
      handoffRevision,
      localAgents: this.state.localAgents,
      usage,
      you,
      roster,
      transcript: [...transcript],
      liveDeltas: new Map(drafts.map((draft) => [draft.entryId, { ...draft }])),
      status: "idle",
      waitingOn: undefined,
      connection: this.state.connection,
    };
    this.postSnapshot();
    this.postRoomPanelSnapshot();
  }

  setHandoffState(
    handoffs: HandoffOffer[],
    handoffAudit: HandoffAuditEntry[],
    handoffRevision: number
  ): void {
    const next = applyHandoffState(this.state, handoffs, handoffAudit, handoffRevision);
    if (next === this.state) return;
    this.state.handoffs = next.handoffs;
    this.state.handoffAudit = next.handoffAudit;
    this.state.handoffRevision = next.handoffRevision;
    this.post({
      type: "handoffs",
      handoffs: this.state.handoffs,
      handoffAudit: this.state.handoffAudit,
      handoffRevision: next.handoffRevision,
    });
    this.postRoomPanelSnapshot();
  }

  /** Work done by an agent, shown apart from the conversation. */
  addAction(entry: ActionEntry): void {
    this.state.actions.push(entry);
    this.post({ type: "action", entry });
    this.postRoomPanelSnapshot();
  }

  setGoalState(goals: Goal[], goalAudit: GoalAuditEntry[], roomRevision: number): void {
    // Ignore stale frames. Reconnect snapshots and live broadcasts carry the
    // same monotonic relay revision, so extension-host ordering stays explicit.
    const next = applyGoalState(this.state, goals, goalAudit, roomRevision);
    if (next === this.state) return;
    this.state.goals = next.goals;
    this.state.goalAudit = next.goalAudit;
    this.state.roomRevision = next.roomRevision;
    this.post({
      type: "goals",
      goals: this.state.goals,
      goalAudit: this.state.goalAudit,
      roomRevision: next.roomRevision,
    });
    this.postRoomPanelSnapshot();
  }

  setContextState(
    context: ContextItem[],
    contextAudit: ContextAuditEntry[],
    contextRevision: number
  ): void {
    if (contextRevision < this.state.contextRevision) return;
    this.state.context = context.map((item) => structuredClone(item));
    this.state.contextAudit = contextAudit.map((entry) => ({ ...entry }));
    this.state.contextRevision = contextRevision;
    this.post({
      type: "context",
      context: this.state.context,
      contextAudit: this.state.contextAudit,
      contextRevision,
    });
    this.postRoomPanelSnapshot();
  }

  setRoster(roster: RosterEntry[], workspaceHost?: string): void {
    this.state.roster = roster;
    this.state.workspaceHost = workspaceHost;
    const youHandle = this.state.you?.handle;
    this.state.you = youHandle ? roster.find((member) => member.handle === youHandle) : undefined;
    this.post({ type: "roster", roster, you: this.state.you, onboarding: this.onboarding() });
    this.postRoomPanelSnapshot();
  }

  /** Update the persistence strip even when no roster field changed. */
  setWorkspaceHost(workspaceHost?: string, localWorkspaceFolder?: string): void {
    this.state.workspaceHost = workspaceHost;
    this.state.localWorkspaceFolder = localWorkspaceFolder;
    this.postRoomPanelSnapshot();
  }

  setLocalAgents(localAgents: LocalAgentOnboarding[]): void {
    this.state.localAgents = localAgents.map((agent) => ({ ...agent }));
    this.post({ type: "onboarding", onboarding: this.onboarding() });
    this.postRoomPanelSnapshot();
  }

  setUsage(usage: AgentUsage[]): void {
    this.state.usage = usage.map((entry) => ({ ...entry }));
    this.postRoomPanelSnapshot();
  }

  addEntry(entry: TranscriptEntry): void {
    this.state.transcript.push(entry);
    this.state.liveDeltas.delete(entry.id);
    this.post({ type: "entry", entry });
    this.postRoomPanelSnapshot();
  }

  addDelta(
    entryId: string,
    text: string,
    agentId?: string,
    authorHandle?: string,
    authorName?: string
  ): void {
    const current = this.state.liveDeltas.get(entryId);
    this.state.liveDeltas.set(entryId, {
      entryId,
      text: `${current?.text ?? ""}${text}`,
      agentId: agentId ?? current?.agentId,
      authorHandle: authorHandle ?? current?.authorHandle,
      authorName: authorName ?? current?.authorName,
      updatedAt: Date.now(),
    });
    this.post({ type: "delta", entryId, text, agentId, authorHandle, authorName });
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
    this.postRoomPanelSnapshot();
  }

  setConnection(connection: ConnectionState): void {
    this.state.connection = connection;
    this.post({ type: "connection", state: connection });
    this.postRoomPanelSnapshot();
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
    const localAgents = this.state.localAgents;
    this.state = { ...emptyState("offline"), localAgents };
    this.postSnapshot();
    this.postRoomPanelSnapshot();
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
      goals: this.state.goals,
      goalAudit: this.state.goalAudit,
      roomRevision: this.state.roomRevision,
      context: this.state.context,
      contextAudit: this.state.contextAudit,
      contextRevision: this.state.contextRevision,
      handoffs: this.state.handoffs,
      handoffAudit: this.state.handoffAudit,
      handoffRevision: this.state.handoffRevision,
      onboarding: this.onboarding(),
      liveDeltas: [...this.state.liveDeltas.values()],
      status: this.state.status,
      waitingOn: this.state.waitingOn,
      connection: this.state.connection,
      approvals: [...this.pendingApprovals.values()].map(({ request }) => request),
    });
  }

  private postRoomPanelSnapshot(): void {
    const panel = this.roomPanel;
    if (!panel) return;
    panel.title = this.state.room ? `Ripieno · ${this.state.room}` : "Ripieno Room";
    void panel.webview.postMessage(
      buildRoomPanelSnapshot({
        room: this.state.room,
        workspaceHost: this.state.workspaceHost,
        mode: this.state.mode,
        you: this.state.you,
        roster: this.state.roster,
        transcriptCount: this.state.transcript.length,
        actions: this.state.actions,
        goals: this.state.goals,
        contextCount: this.state.context.filter(
          (item) => item.status !== "archived" && item.status !== "superseded"
        ).length,
        handoffs: this.state.handoffs,
        usage: this.state.usage,
        localAgents: this.state.localAgents,
        localWorkspaceFolder: this.state.localWorkspaceFolder,
        status: this.state.status,
        waitingOn: this.state.waitingOn,
        connection: this.state.connection,
      })
    );
  }

  private onboarding(): OnboardingDecision {
    return decideOnboarding({
      room: this.state.room,
      role: this.state.you?.role,
      configuredAgents: this.state.localAgents,
      attachedAgentIds: this.state.you?.agents.map((agent) => agent.id) ?? [],
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
<nav id="surfaceTabs" class="surface-tabs" role="tablist" aria-label="Ripieno room surfaces">
  <button id="roomTab" class="surface-tab active" type="button" role="tab" aria-selected="true" aria-controls="roomPanel" data-surface="room">Room</button>
  <button id="contextTab" class="surface-tab" type="button" role="tab" aria-selected="false" aria-controls="contextPanel" data-surface="context">Context <span id="contextCount" class="tab-count"></span></button>
  <button id="agentsTab" class="surface-tab" type="button" role="tab" aria-selected="false" aria-controls="agentsPanel" data-surface="agents">Agents <span id="agentCount" class="tab-count"></span></button>
</nav>
<section id="roomPanel" class="surface-panel" role="tabpanel" aria-labelledby="roomTab">
<section id="onboarding" class="onboarding" aria-labelledby="onboardingTitle">
  <h2 id="onboardingTitle" class="sr-only">Getting started</h2>
  <ol id="onboardingSteps" class="onboarding-steps" aria-label="Getting started progress"></ol>
  <button id="onboardingAction" class="onboarding-action" type="button" hidden></button>
  <p id="onboardingHelp" class="onboarding-help" hidden>A ChatGPT web conversation cannot be imported. To use Codex, install the Codex CLI and run <code>codex login</code> to sign in with ChatGPT, or use an API key. API-key usage is billed separately through the OpenAI Platform.</p>
</section>
<div class="transcript-wrap">
  <div id="transcript" class="transcript" role="log" aria-live="polite" aria-label="Room conversation"></div>
  <button id="jumpLatest" class="jump-latest" type="button" hidden>Latest <span aria-hidden="true">↓</span></button>
</div>
<details id="goals" class="goals" hidden>
  <summary id="goalsSummary" class="goals-summary">Goals</summary>
  <div id="goalsList" class="goals-list" role="list" aria-label="Room goals"></div>
</details>
<div id="goalAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<section id="handoffs" class="handoffs" aria-labelledby="handoffsTitle" hidden>
  <div id="handoffsTitle" class="handoffs-title">Agent handoffs</div>
  <div id="handoffsList" class="handoffs-list" role="list" aria-label="Agent handoff lifecycle"></div>
</section>
<div id="handoffAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
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
</section>
<section id="contextPanel" class="surface-panel context-panel" role="tabpanel" aria-labelledby="contextTab" hidden>
  <header class="panel-intro">
    <strong>Shared room context</strong>
    <span>Durable, attributed memory. Agent additions remain proposed until a person accepts them.</span>
  </header>
  <form id="contextForm" class="context-form">
    <div class="context-form-row">
      <select id="contextKind" class="context-kind" aria-label="Context kind">
        <option value="decision">Decision</option>
        <option value="fact">Fact</option>
        <option value="constraint">Constraint</option>
        <option value="question">Question</option>
        <option value="reference">Reference</option>
        <option value="note" selected>Note</option>
      </select>
      <input id="contextTitle" class="context-title-input" maxlength="160" required aria-label="Context title" placeholder="What should the room remember?" />
    </div>
    <textarea id="contextBody" class="context-body-input" maxlength="4000" rows="3" aria-label="Context detail" placeholder="Detail, evidence, or rationale…"></textarea>
    <div class="context-form-row">
      <input id="contextTags" class="context-tags-input" aria-label="Context tags" placeholder="tags, comma-separated" />
      <button id="contextAdd" class="context-add" type="submit">Add</button>
    </div>
    <div id="contextValidation" class="composer-validation" role="alert" hidden></div>
  </form>
  <div id="contextList" class="context-list" role="list" aria-label="Shared room context"></div>
  <div id="contextAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
</section>
<section id="agentsPanel" class="surface-panel agents-panel" role="tabpanel" aria-labelledby="agentsTab" hidden>
  <header class="panel-intro">
    <strong>Agent inspectors</strong>
    <span>Live observable activity, ownership and capability. Hidden reasoning and raw logs are never shared.</span>
  </header>
  <div id="agentInspectors" class="agent-inspectors" role="list" aria-label="Agents in this room"></div>
</section>
<script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private renderRoomPanelHtml(webview: vscode.Webview): string {
    const csp = nonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "roomPanel.css")
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "roomPanel.js")
    );
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
<title>Ripieno Room</title>
</head>
<body>
<main class="room-workbench">
  <header class="workbench-header">
    <div>
      <span class="eyebrow">Room workspace</span>
      <h1 id="panelRoomName">Not connected</h1>
      <p id="panelRoomMeta" class="room-meta">Open a room to inspect its agents.</p>
    </div>
    <div id="panelConnection" class="connection offline" role="status" aria-live="polite">offline</div>
  </header>

  <section id="workspaceState" class="workspace-state offline" role="status" aria-live="polite" aria-atomic="true">
    <span class="workspace-state-mark" aria-hidden="true"></span>
    <div>
      <span class="eyebrow">Workspace persistence</span>
      <strong id="workspaceStateLabel">Workspace offline</strong>
      <p id="workspaceStateDetail">No member is hosting a folder.</p>
    </div>
  </section>

  <section class="overview" aria-labelledby="overviewTitle">
    <div class="section-heading">
      <div>
        <span class="eyebrow">Shared, relay-authoritative</span>
        <h2 id="overviewTitle">Room overview</h2>
      </div>
      <span id="overviewUpdated" class="updated"></span>
    </div>
    <div id="overviewMetrics" class="overview-metrics"></div>
    <div id="roomPulse" class="room-pulse" role="list" aria-label="Agent status overview"></div>
  </section>

  <section class="agents-workbench" aria-labelledby="agentsTitle">
    <div class="section-heading agents-heading">
      <div>
        <span class="eyebrow">Exact agent identities</span>
        <h2 id="agentsTitle">Agents</h2>
      </div>
      <div id="statusFilters" class="status-filters" role="group" aria-label="Filter agents by status">
        <button type="button" data-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-filter="idle" aria-pressed="true">Idle</button>
        <button type="button" data-filter="unknown" aria-pressed="true">Not reported</button>
      </div>
    </div>
    <div id="agentTabRail" class="agent-tab-rail" role="tablist" aria-label="Room agents"></div>
    <div id="filterEmpty" class="empty-state" hidden>No agents match the selected status filters.</div>
    <article id="agentDetail" class="agent-detail" role="tabpanel" tabindex="0"></article>
  </section>
</main>
<div id="panelAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
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
