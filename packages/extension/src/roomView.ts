// WebviewViewProvider for the "ripieno.room" view. Owns the webview's HTML and
// is the single source of truth for room state on the extension-host side,
// so the view can be torn down and recreated (VS Code disposes hidden
// webviews' DOM but keeps this provider alive) without losing history:
// instead of `retainContextWhenHidden` (which keeps a whole hidden webview
// process around) we just resend a full snapshot on visibility change.

import * as vscode from "vscode";
import type { WorkClaim } from "@ripieno/protocol";
import { parseClaimPanelMessage, type ClaimPanelMessage } from "./teamBoard";
import type {
  ActionEntry,
  AgentDraft,
  AgentProposal,
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
  collaborationSupported?: boolean;
  workClaims?: WorkClaim[];
  workClaimRevision?: number;
  claimsSupported?: boolean;
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
  /** agentId -> current relay-owned temporary patch. */
  proposals: Map<string, AgentProposal>;
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
    proposals: new Map(),
    status: "idle",
    connection,
  };
}

export interface BrowserPanelState {
  sessionId?: string;
  label?: string;
  url?: string;
  title?: string;
  image?: string;
  busy?: boolean;
  error?: string;
}

/** Messages the extension host pushes into the webview. */
type ToWebview =
  | { type: "showChat" }
  | { type: "approvalResolved"; id: string }
  | { type: "resumeRoom"; room?: string }
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
    private readonly onOpenAgentLocation: (agentId: string) => void,
    private readonly onOpenAgentProposal: (agentId: string) => void,
    private readonly onClaimAction: (message: ClaimPanelMessage) => void = () => undefined,
    private readonly onCollaborationAction: (action: string, id?: string) => void = () => undefined,
    private readonly extensionVersion = ""
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((raw: unknown) => {
      this.handleRoomMessage(raw);
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.postSnapshot();
      }
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
        if (!this.roomPanel?.visible) this.resolvePendingApprovals();
      }
    });
  }

  private handleRoomMessage(raw: unknown): void {
    if (this.handleWorkspaceMessage(raw) || this.handleCollaborationMessage(raw)) return;
    const msg = parseRoomViewMessage(raw);
    if (!msg) return;

    if (msg.type === "ready") {
      this.postSnapshot();
      this.post({ type: "resumeRoom", room: this.resumeRoom });
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
      this.post({ type: "approvalResolved", id: msg.id });
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
  }

  setCollaborationSupported(supported: boolean): void { this.state.collaborationSupported = supported; this.postRoomPanelSnapshot(); }

  private browserState: BrowserPanelState = {};
  private browserHandler: (message: unknown) => void = () => undefined;
  setBrowserState(state: BrowserPanelState): void {
    this.browserState = state;
    void this.roomPanel?.webview.postMessage({ type: "browserState", state });
  }
  setBrowserHandler(handler: (message: unknown) => void): void { this.browserHandler = handler; }

  /** Browser control stays owner-local and bound to the displayed session. */
  private handleBrowserMessage(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (v.type !== "browserAction") return false;
    if (typeof v.sessionId !== "string" || !v.sessionId || v.sessionId !== this.browserState.sessionId) return true;
    const keys: Record<string, string[]> = {
      refresh: [], close: [], navigate: ["url"], click: ["x", "y"], type: ["text"], scroll: ["deltaY"], press: ["key"],
    };
    if (typeof v.action !== "string" || !Object.hasOwn(keys, v.action)) return true;
    const allowed = ["type", "sessionId", "action", ...keys[v.action]];
    if (Object.keys(v).length !== allowed.length || Object.keys(v).some(key => !allowed.includes(key))) return true;
    if (v.action === "navigate" && (typeof v.url !== "string" || !v.url.trim() || v.url.length > 4096)) return true;
    if (v.action === "click" && (![v.x, v.y].every(n => typeof n === "number" && Number.isFinite(n)) || Number(v.x) < 0 || Number(v.x) >= 1280 || Number(v.y) < 0 || Number(v.y) >= 800)) return true;
    if (v.action === "type" && (typeof v.text !== "string" || v.text.length === 0 || v.text.length > 4000)) return true;
    if (v.action === "scroll" && (typeof v.deltaY !== "number" || !Number.isFinite(v.deltaY) || Math.abs(v.deltaY) > 1600)) return true;
    if (v.action === "press" && (typeof v.key !== "string" || !["Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp"].includes(v.key))) return true;
    if (this.browserState.busy && v.action !== "close") return true;
    this.browserHandler({ ...v });
    return true;
  }

  private resumeRoom?: string;
  private initialPanelPage?: "work" | "brain";
  setResumeRoom(room?: string): void { this.resumeRoom = room; this.post({ type: "resumeRoom", room }); this.postRoomPanelSnapshot(); }

  private handleWorkspaceMessage(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (v.type !== "workspaceAction") return false;
    if (Object.keys(v).length !== 2 || typeof v.action !== "string") return true;
    const online = this.state.connection === "online";
    const member = this.state.you?.role === "owner" || this.state.you?.role === "member";
    if (v.action === "resumeRoom" && !this.state.room && this.resumeRoom) void vscode.commands.executeCommand("ripieno.resumeRoom");
    else if (v.action === "openWorkspace") this.openRoomPanel();
    else if (v.action === "openWork") this.openRoomPanel("work");
    else if (v.action === "openBrain") this.openRoomPanel("brain");
    else if (v.action === "addAgent" && online && member) void vscode.commands.executeCommand("ripieno.addAgent");
    else if (v.action === "copyInvite" && online) void vscode.commands.executeCommand("ripieno.copyInvite");
    else if (v.action === "chat") {
      if (this.roomPanel?.visible) this.post({ type: "showChat" });
      else void vscode.commands.executeCommand("ripieno.room.focus").then(() => this.post({ type: "showChat" }));
    } else if (v.action === "openFolder") void vscode.commands.executeCommand("vscode.openFolder");
    else if (v.action === "hostWorkspace" && online && member && !this.state.workspaceHost) void vscode.commands.executeCommand("ripieno.hostWorkspace");
    else if (v.action === "mountWorkspace" && online && this.state.workspaceHost) void vscode.commands.executeCommand("ripieno.mountWorkspace");
    else if (["startSolo", "joinRoom", "addAgent", "attachAgent"].includes(v.action)) {
      const command = onboardingCommandFor(v.action as Parameters<typeof onboardingCommandFor>[0], this.state);
      if (command) void vscode.commands.executeCommand(command);
    }
    return true;
  }

  private handleCollaborationMessage(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const v = value as Record<string, unknown>;
    if (v.type !== "collaborationAction") return false;
    if (Object.keys(v).some(k => !["type", "action", "id"].includes(k))) return true;
    if (typeof v.action !== "string" || !["open", "edit", "comment", "task", "plan", "memory", "progress", "assign"].includes(v.action)) return true;
    if (v.action === "open" || v.action === "edit" || v.action === "progress" || v.action === "assign") {
      if (typeof v.id !== "string" || !this.state.context.some(c => c.id === v.id)) return true;
    } else if (v.id !== undefined) return true;
    this.onCollaborationAction(v.action, typeof v.id === "string" ? v.id : undefined);
    return true;
  }

  /** Open (or reveal) the editor-sized Room overview and exact-agent tabs. */
  openRoomPanel(page?: "work" | "brain"): void {
    if (this.roomPanel) {
      this.roomPanel.reveal(this.roomPanel.viewColumn, false);
      this.postRoomPanelSnapshot();
      if (page) void this.roomPanel.webview.postMessage({ type: "navigateWorkspace", page });
      return;
    }
    this.initialPanelPage = page;

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
    this.postSidebarMode();
    panel.webview.html = this.renderRoomPanelHtml(panel.webview);
    panel.webview.onDidReceiveMessage((value: unknown) => {
      if (this.handleBrowserMessage(value) || this.handleWorkspaceMessage(value) || this.handleCollaborationMessage(value)) return;
      if (parseRoomViewMessage(value)) { this.handleRoomMessage(value); return; }
      const claimMessage = parseClaimPanelMessage(value);
      if (claimMessage) { this.onClaimAction(claimMessage); return; }
      if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 1 &&
        (value as { type?: unknown }).type === "panelReady"
      ) {
        this.postRoomPanelSnapshot();
        if (this.initialPanelPage) void panel.webview.postMessage({ type: "navigateWorkspace", page: this.initialPanelPage });
        this.initialPanelPage = undefined;
        void panel.webview.postMessage({ type: "browserState", state: this.browserState });
      } else if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 2 &&
        (value as { type?: unknown }).type === "openAgentLocation" &&
        typeof (value as { agentId?: unknown }).agentId === "string" &&
        (value as { agentId: string }).agentId.length <= 300
      ) {
        this.onOpenAgentLocation((value as { agentId: string }).agentId);
      } else if (
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).length === 2 &&
        (value as { type?: unknown }).type === "openAgentProposal" &&
        typeof (value as { agentId?: unknown }).agentId === "string" &&
        (value as { agentId: string }).agentId.length <= 300
      ) {
        this.onOpenAgentProposal((value as { agentId: string }).agentId);
      }
    });
    panel.onDidChangeViewState(() => {
      this.postSidebarMode();
      if (panel.visible) { this.postSnapshot(); this.postRoomPanelSnapshot(); }
    });
    // Expiry stays honest even when no new network frame reaches the panel.
    const refresh = setInterval(() => { if (panel.visible) this.postRoomPanelSnapshot(); }, 5_000);
    panel.onDidDispose(() => {
      clearInterval(refresh);
      if (this.roomPanel === panel) this.roomPanel = undefined;
      this.postSidebarMode();
      if (!this.view?.visible) this.resolvePendingApprovals();
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
    proposals: AgentProposal[] = [],
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
      proposals: new Map(proposals.map((proposal) => [proposal.agentId, { ...proposal }])),
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

  setWorkClaims(claims: WorkClaim[], revision: number, supported = true): void {
    if (revision < (this.state.workClaimRevision ?? 0)) return;
    this.state.workClaims = claims.map(c => ({ ...c, paths: [...c.paths] }));
    this.state.workClaimRevision = revision;
    this.state.claimsSupported = supported;
    this.postRoomPanelSnapshot();
  }

  claimResult(ok: boolean, message: string): void {
    void this.roomPanel?.webview.postMessage({ type: "claimResult", ok, message });
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

  setProposal(proposal: AgentProposal): void {
    this.state.proposals.set(proposal.agentId, { ...proposal });
    this.postRoomPanelSnapshot();
  }

  resolveProposal(proposalId: string, agentId: string): void {
    const current = this.state.proposals.get(agentId);
    if (!current || current.id !== proposalId) return;
    this.state.proposals.delete(agentId);
    this.postRoomPanelSnapshot();
  }

  clearProposals(): void {
    if (this.state.proposals.size === 0) return;
    this.state.proposals.clear();
    this.postRoomPanelSnapshot();
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
    const visibleViews = [this.view, this.roomPanel].filter((view) => view?.visible);
    if (visibleViews.length === 0) {
      return Promise.resolve(undefined);
    }
    const id = `ap_${this.nextApprovalId++}`;
    const pending: PendingApproval = { id, ...request };
    return new Promise<ApprovalChoice | undefined>((resolve) => {
      this.pendingApprovals.set(id, { request: pending, resolve });
      void Promise.all(visibleViews.map(view => view!.webview.postMessage({ type: "approval", ...pending }))).then((results) => {
        const delivered = results.some(Boolean);
        const current = this.pendingApprovals.get(id);
        if (!delivered && current) {
          this.pendingApprovals.delete(id);
          current.resolve(undefined);
        }
      });
      // If the view is hidden or reloaded before an answer arrives, the card is
      // gone; give up so the modal can take over instead of stalling.
      const check = setInterval(() => {
        if (!this.view?.visible && !this.roomPanel?.visible && this.pendingApprovals.has(id)) {
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
    void this.roomPanel?.webview.postMessage(msg);
  }

  private postSidebarMode(): void {
    void this.view?.webview.postMessage({ type: "workspaceVisibility", visible: Boolean(this.roomPanel?.visible) });
  }

  private postSnapshot(): void {
    this.postSidebarMode();
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
      { ...buildRoomPanelSnapshot({
        workClaims: this.state.workClaims,
        claimsSupported: this.state.claimsSupported,
        pendingApprovalCount: this.pendingApprovals.size,
        room: this.state.room,
        workspaceHost: this.state.workspaceHost,
        mode: this.state.mode,
        you: this.state.you,
        roster: this.state.roster,
        transcriptCount: this.state.transcript.length,
        actions: this.state.actions,
        proposals: [...this.state.proposals.values()],
        goals: this.state.goals,
        collaborationSupported: this.state.collaborationSupported,
        context: this.state.context,
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
      }), onboarding: this.onboarding(), hasLocalFolder: Boolean(vscode.workspace.workspaceFolders?.some(f => f.uri.scheme === "file")), extensionVersion: this.extensionVersion, resumeRoom: this.resumeRoom }
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
<section id="workspaceNotice" class="workspace-notice" hidden>
  <p>Conversation and tools are open in your workspace.</p>
  <button id="focusWorkspace" type="button">Focus workspace ↗</button>
</section>
${this.renderRoomContent()}
<script nonce="${csp}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private renderRoomContent(): string {
    return `<header id="header" class="header">
  <div class="room-meta">
    <div id="roomLabel" class="room-label">Not connected</div>
    <span id="modeBadge" class="mode-badge" hidden></span>
  </div>
  <div id="statusPill" class="status-pill idle" role="status" aria-live="polite">idle</div>
  <div id="roster" class="roster" role="list" aria-label="People in this room"></div>
  <button id="openWorkspace" class="onboarding-action" type="button">Open workspace ↗</button>
</header>
<nav id="surfaceTabs" class="surface-tabs" role="tablist" aria-label="Ripieno room surfaces">
  <button id="roomTab" class="surface-tab active" type="button" role="tab" aria-selected="true" aria-controls="roomPanel" data-surface="room">Chat</button>
  <button id="workTab" class="surface-tab" type="button" role="tab" aria-selected="false" aria-controls="workPanel" data-surface="work">Work</button>
  <button id="contextTab" class="surface-tab" type="button" role="tab" aria-selected="false" aria-controls="contextPanel" data-surface="context">Brain <span id="contextCount" class="tab-count"></span></button>
  <button id="agentsTab" class="surface-tab" type="button" role="tab" aria-selected="false" aria-controls="agentsPanel" data-surface="agents">Agents <span id="agentCount" class="tab-count"></span></button>
</nav>
<section id="roomPanel" class="surface-panel" role="tabpanel" aria-labelledby="roomTab">
<section id="onboarding" class="onboarding" aria-labelledby="onboardingTitle">
  <h2 id="onboardingTitle" class="sr-only">Getting started</h2>
  <ol id="onboardingSteps" class="onboarding-steps" aria-label="Getting started progress"></ol>
  <button id="resumeRoom" class="onboarding-action" type="button" hidden></button>
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
<section id="workPanel" class="surface-panel" role="tabpanel" aria-labelledby="workTab" hidden><header class="panel-intro"><strong>Tasks and shared work</strong><span>Plan work, choose an owner and track progress in the workspace.</span><button id="openWork" class="onboarding-action" type="button">Open Work ↗</button></header></section>
<section id="contextPanel" class="surface-panel context-panel" role="tabpanel" aria-labelledby="contextTab" hidden>
  <header class="panel-intro">
    <strong>Brain</strong><button id="openBrain" class="context-action" type="button">Open Brain ↗</button>
    <span>Decisions, notes and references shared with your room. Review agent suggestions before accepting them.</span>
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
    <strong>Agents</strong>
    <span>See who owns each agent and what it is working on.</span>
  </header>
  <div id="agentInspectors" class="agent-inspectors" role="list" aria-label="Agents in this room"></div>
</section>
`;
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
      "img-src data:",
    ].join("; ");

    const chatStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const chatScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${cspHeader}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${chatStyleUri}" />
<link rel="stylesheet" href="${styleUri}" />
<title>Ripieno</title>
</head>
<body class="workspace-shell">
<main class="room-workbench">
  <aside class="workspace-rail" aria-label="Ripieno navigation">
    <div class="workspace-brand">Ripieno <span id="extensionVersion"></span></div>
    <nav id="workspaceNav" class="workspace-nav" aria-label="Workspace sections">
      <button type="button" data-page="chat" aria-pressed="true">Chat</button>
      <button type="button" data-page="work" aria-pressed="false">Tasks</button>
      <button type="button" data-page="brain" aria-pressed="false">Brain</button>
      <button type="button" data-page="agents" aria-pressed="false">Agents</button>
      <button type="button" data-page="browser" aria-pressed="false">Browser</button>
      <button type="button" data-page="review" aria-pressed="false">Review <span id="reviewCount"></span></button>
    </nav>
    <div class="rail-spacer"></div>
    <details class="folder-disclosure"><summary>Shared folder</summary>
      <section id="workspaceState" class="workspace-state offline" role="status" aria-live="polite" aria-atomic="true">
        <strong id="workspaceStateLabel">No shared folder</strong>
        <p id="workspaceStateDetail">Share a folder when you are ready to work together.</p>
      </section>
      <div id="workspaceActions" class="workspace-actions"></div>
    </details>
  </aside>
  <section class="workspace-main" aria-label="Conversation">
    <header class="workbench-header">
      <div class="workspace-title"><h1 id="panelRoomName">Ripieno</h1><span id="panelRoomMeta"></span></div>
      <div class="header-controls"><span id="panelConnection" class="connection offline" role="status" aria-live="polite">offline</span><button id="shareRoom" type="button" hidden>Share</button></div>
    </header>
    <section id="setupGuide" class="setup-guide" aria-labelledby="welcomeTitle">
      <div class="welcome-copy"><span class="welcome-kicker">A shared place to think and build</span><h2 id="welcomeTitle">Welcome to Ripieno</h2><p id="setupHint"></p><div id="setupActions"></div></div>
    </section>
    <div id="connectionPrompt" class="connection-prompt" hidden></div>
    <div id="workspaceConversation" class="workspace-conversation" hidden>${this.renderRoomContent()}</div>
  </section>
  <aside id="workspaceInspector" class="workspace-inspector" aria-labelledby="inspectorTitle" hidden>
    <header class="inspector-header"><h2 id="inspectorTitle">Tasks</h2><button id="closeInspector" type="button" aria-label="Close details">×</button></header>
    <div class="inspector-content">
  <section data-section="work" class="claims-section" aria-labelledby="claimsTitle">
    <h2 id="claimsTitle" class="sr-only">Tasks</h2>
    <div class="brain-heading"><div id="workTaskActions"></div></div>
    <div id="workTasks" class="brain-list"></div>
    <details class="coordination-details"><summary>Coordinate shared files <span id="claimCount" class="updated"></span></summary>
    <p class="board-help">Claims belong to people. Shared-file overlap is a warning, not a lock or permission to edit. Claims end when their editor disconnects or stops renewing them.</p>
    <div id="boardAttention" class="board-attention" role="status" aria-live="polite"></div>
    <div id="overlapWarnings" class="overlap-warnings" role="list" aria-label="Possible overlapping work"></div>
    <form id="claimForm" class="claim-form">
      <label for="claimTask">What will you work on?</label>
      <input id="claimTask" maxlength="240" required placeholder="For example, authentication tests" />
      <div class="claim-form-options">
        <div><label for="claimAgent">Agent</label><select id="claimAgent"><option value="">I'll coordinate it myself</option></select></div>
        <div><label for="claimGoal">Related goal</label><select id="claimGoal"><option value="">No goal link</option></select></div>
      </div>
      <label for="claimPaths">Shared-workspace files (optional, one path per line)</label>
      <textarea id="claimPaths" rows="2" maxlength="2000" placeholder="src/auth.ts&#10;test/auth.test.ts" aria-describedby="claimPathsHelp"></textarea>
      <p id="claimPathsHelp" class="board-help">Up to eight exact relative paths in the host's folder. Private copies are not compared.</p>
      <div id="claimPreflight" class="claim-preflight" role="status" aria-live="polite"></div>
      <button id="claimSubmit" type="submit">Claim work</button>
      <p id="claimFeedback" class="claim-feedback" role="status" aria-live="polite"></p>
    </form>

    <div id="workClaims" class="work-claims" role="list" aria-label="Claimed work"></div>
    </details>
  </section>

  <section data-section="brain" class="shared-brain" aria-labelledby="brainTitle">
    <div class="brain-heading"><h2 id="brainTitle" class="sr-only">Brain</h2><div id="brainActions"></div></div>
    <p class="detail-note">Shared, attributed records. Code anchors open only while their host and file content still match.</p>
    <div class="brain-filters"><input id="brainSearch" type="search" placeholder="Search titles, details, tags or owners" aria-label="Search Brain" /><select id="brainFilter" aria-label="Record type"><option value="all">All records</option><option value="plan">Plans</option><option value="task">Tasks</option><option value="comment">Code comments</option><option value="memory">Brain memory</option><option value="proposed">Proposed context</option><option value="retired">Archived / superseded</option></select></div>
    <div id="brainList" class="brain-list"></div>
    <details><summary>Handoff history and recovery</summary><div id="handoffRecovery" class="brain-list"></div></details>
  </section>

  <section data-section="agents" class="agents-workbench" aria-labelledby="agentsTitle">
    <div class="section-heading agents-heading">
      <div>

        <h2 id="agentsTitle" class="sr-only">Agents</h2>
      </div>
      <div id="statusFilters" class="status-filters" role="group" aria-label="Filter agents by status">
        <button type="button" data-filter="active" aria-pressed="true">Active</button>
        <button type="button" data-filter="idle" aria-pressed="true">Idle</button>
        <button type="button" data-filter="unknown" aria-pressed="true">Not reported</button>
      </div>
    </div>
    <div id="agentSetupActions" class="workspace-actions"></div>
    <div id="agentTabRail" class="agent-tab-rail" role="tablist" aria-label="Room agents"></div>
    <div id="filterEmpty" class="empty-state" hidden>No agents match the selected status filters.</div>
    <article id="agentDetail" class="agent-detail" role="tabpanel" tabindex="0"></article>
  </section>
      <section data-section="browser" aria-label="Agent browser">
        <p id="browserStatus" class="browser-status" role="status">Ask an attached Codex or Claude agent to open a browser.</p>
        <form id="browserNavigate" class="browser-controls" hidden><input id="browserAddress" aria-label="Browser address" type="url" maxlength="4096" placeholder="https://…" required /><button class="board-button" type="submit">Go</button><button id="browserRefresh" class="board-button" type="button" aria-label="Refresh browser observation">Refresh</button><button id="browserClose" class="board-button" type="button">Stop</button></form>
        <img id="browserImage" class="browser-image" alt="Agent browser page" aria-disabled="true" hidden />
        <div id="browserInput" hidden>
          <div class="browser-tools"><button class="board-button" type="button" data-browser-scroll="-550">Scroll up</button><button class="board-button" type="button" data-browser-scroll="550">Scroll down</button><button class="board-button" type="button" data-browser-key="Tab">Tab</button><button class="board-button" type="button" data-browser-key="Enter">Enter</button><button class="board-button" type="button" data-browser-key="Escape">Escape</button></div>
          <form id="browserType" class="browser-type"><input id="browserText" aria-label="Text to type into the focused browser field" maxlength="4000" placeholder="Type into the focused page field…" required /><button class="board-button" type="submit">Type</button></form>
          <p class="detail-note">Click the page to focus a field. This browser belongs to this editor; Stop closes the session.</p>
        </div>
      </section>
      <section data-section="review" aria-label="Review"><p class="detail-note">Review proposed changes from Agents. Permission requests appear above the conversation's composer.</p><div id="reviewContent"></div></section>
    </div>
  </aside>
</main>
<div id="panelAnnouncements" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<script nonce="${csp}" src="${chatScriptUri}"></script>
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
