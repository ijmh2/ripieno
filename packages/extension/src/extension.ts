import * as vscode from "vscode";
import { spawn } from "child_process";
import type { Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { resolveIdentity, resolveIdentityWithToken, relayRequiresIdentity } from "./identity";
import { SoloRelay } from "./soloRelay";
import { buildInvite, describeInvite, parseInvite } from "./invite";
import {
  canUseLegacyRoomToken,
  roomTokenSecretKey,
  validateProviderBaseUrl,
  validateRelayUrl,
} from "./relaySecurity";

/** Where the room token lives, when it did not come from settings. */
const LEGACY_ROOM_TOKEN_SECRET = "ripieno.roomToken";
import * as os from "node:os";
import { RelayClient, type ConnectionState } from "@ripieno/relay-client";
import { ToolExecutor, registerProposedDocuments } from "./toolExecutor";
import { RoomViewProvider } from "./roomView";
import { AgentHost, type AgentState } from "./agentHost";
import { RoomsTreeProvider, type MyAgent } from "./roomsTree";
import {
  PROVIDERS,
  isWorkspaceProvider,
  providerById,
  secretKeyFor,
  type AgentPermission,
  type ProviderPreset,
} from "./runners";
import { ApprovalBridge } from "./approvals";
import { WorkspaceFileSystem, WORKSPACE_SCHEME, uriFor } from "./workspaceFs";
import { WorkspaceTreeProvider, isHostDocument } from "./workspaceTree";
import {
  CODEX_SETUP_URL,
  agentIdFromTreeNode,
  isCodexLoginReady,
  isUnusedLegacyBootstrapAgent,
  nextAgentLabel,
  parseCodexModelCatalog,
  needsSharedRoomAgentConsent,
  shouldStartAddAgentForAttach,
} from "./agentSetup";
import { parseModelValue, resolveModelRequest } from "./agentCommands";

export function activate(context: vscode.ExtensionContext): void {
  const toolExecutor = new ToolExecutor();
  // Backs the right-hand side of the diff shown before any write is applied.
  context.subscriptions.push(registerProposedDocuments());
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => void handleInvite(uri),
    })
  );
  // Flush the solo room's history before the window goes, and free the port.
  context.subscriptions.push({ dispose: () => void solo.stop() });
  let relay: RelayClient | undefined;
  let currentRoom: string | undefined;
  let hostingWorkspace = false;
  let nextFsRequest = 0;
  let watcher: vscode.FileSystemWatcher | undefined;
  /** Paths changed since the last publish, coalesced — a build touches thousands. */
  const changedPaths = new Set<string>();
  let publishTimer: NodeJS.Timeout | undefined;
  let me: Member | undefined;
  /**
   * Proves who `me` is to the relay, when it asks.
   *
   * Session-scoped and deliberately not on Member: that type is broadcast to
   * every client in the room.
   */
  let githubToken: string | undefined;
  /** Resolved on join: either the configured relay, or the one we run ourselves. */
  let activeRelayUrl: string | undefined;
  let cachedRoomToken: string | undefined;
  /** Approved local-agent attaches, scoped to this extension-host session. */
  const sharedRoomAgentConsent = new Set<string>();
  const solo = new SoloRelay();
  let inRoomContext: boolean | undefined;

  /** Keep native Room-title actions aligned with actual relay membership. */
  function setInRoomContext(inRoom: boolean): void {
    if (inRoomContext === inRoom) return;
    inRoomContext = inRoom;
    void vscode.commands.executeCommand("setContext", "ripieno.inRoom", inRoom);
  }

  // A saved room is only an invitation to rejoin; activation starts disconnected.
  setInRoomContext(false);

  // A member may run several agents at once — a coder and a reviewer, say —
  // each with its own process, session and label in the transcript.
  const agents = new Map<string, AgentHost>();
  interface AgentSpecRecord {
    id: string;
    label: string;
    brief?: string;
    cwd?: string;
    model?: string;
    providerId: string;
    baseUrl?: string;
    /** cli providers: the executable and its arguments. */
    command?: string;
    args?: string[];
    /** The editable trust boundary for this one agent. */
    permissions?: AgentPermission;
  }
  const specs = new Map<string, AgentSpecRecord>();

  /**
   * What survives a window reload.
   *
   * Nothing did. Reloading lost the room you were in, every agent you had added
   * — their models, briefs, working folders and providers — and each agent's
   * session, so every one of them started cold on a conversation the *room*
   * still remembered. The relay was persisting faithfully to a client that
   * threw its own state away on every reload.
   *
   * Session ids live here too rather than in the runner: the runner is
   * constructed per attach, so an id held there cannot outlive the thing that
   * loses it.
   */
  const STATE_KEY = "ripieno.session";
  interface PersistedState {
    room?: string;
    relayUrl?: string;
    agents: AgentSpecRecord[];
    /** Claude Code session per agent id, so a reload resumes rather than restarts. */
    sessions: Record<string, string>;
  }

  function loadState(): PersistedState {
    const saved = context.globalState.get<PersistedState>(STATE_KEY);
    return { agents: [], sessions: {}, ...saved };
  }

  function saveState(patch: Partial<PersistedState>): void {
    const next: PersistedState = {
      ...loadState(),
      agents: [...specs.values()],
      ...patch,
    };
    void context.globalState.update(STATE_KEY, next);
  }
  const approvals = new ApprovalBridge();
  const permissionServerPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "permissionServer.js"
  ).fsPath;
  const workspaceServerPath = vscode.Uri.joinPath(
    context.extensionUri,
    "dist",
    "workspaceServer.js"
  ).fsPath;

  const roomView = new RoomViewProvider(context.extensionUri, (text) => {
    if (handleRoomCommand(text)) return;
    relay?.send({ t: "say", text });
  });

  // The host's workspace, as a real filesystem. Read-only: edits go through
  // "Propose change to host" so the owner sees a diff instead of a stream of
  // approval prompts triggered by autosave.
  const workspaceFs = new WorkspaceFileSystem();
  const workspaceTree = new WorkspaceTreeProvider();

  const roomsTree = new RoomsTreeProvider({
    attachAgent: (id) => void attachAgent(id),
    detachAgent: (id) => detachAgent(id),
    addAgent: () => void addAgent(),
    joinRoom: () => void joinRoom(),
  });

  // Prefer an inline card in the room panel over a focus-stealing modal; the
  // bridge falls back to a modal when the panel is hidden, so a request is
  // never shown nowhere.
  approvals.setPrompt((request) => roomView.requestApproval(request));

  // Restore configured agents before anything concludes there are none. Older
  // versions silently inserted one untouched Claude agent. Removing only that
  // exact, never-used bootstrap record gives the choice back to the user while
  // preserving every configured or successfully-used agent.
  const restored = loadState();
  const discardLegacyBootstrap = isUnusedLegacyBootstrapAgent(
    restored.agents,
    restored.sessions
  );
  for (const spec of discardLegacyBootstrap ? [] : restored.agents) specs.set(spec.id, spec);
  if (discardLegacyBootstrap) saveState({ sessions: restored.sessions });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(RoomViewProvider.viewId, roomView),
    vscode.workspace.registerFileSystemProvider(WORKSPACE_SCHEME, workspaceFs, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
    vscode.window.createTreeView(WorkspaceTreeProvider.viewId, {
      treeDataProvider: workspaceTree,
    }),
    vscode.window.createTreeView(RoomsTreeProvider.viewId, {
      treeDataProvider: roomsTree,
      dragAndDropController: roomsTree,
    }),
    vscode.commands.registerCommand("ripieno.joinRoom", () => joinRoom()),
    vscode.commands.registerCommand("ripieno.copyInvite", () => copyInvite()),
    vscode.commands.registerCommand("ripieno.setRole", (node?: unknown) => setRole(node)),
    vscode.commands.registerCommand("ripieno.leaveRoom", () => leaveRoom()),
    vscode.commands.registerCommand("ripieno.signIn", () => signIn()),
    vscode.commands.registerCommand("ripieno.addAgent", () => addAgent()),
    vscode.commands.registerCommand("ripieno.customizeAgent", (node?: unknown) =>
      void customizeAgent(idFromNode(node))
    ),
    vscode.commands.registerCommand("ripieno.removeAgent", (node?: unknown) =>
      void removeAgent(idFromNode(node))
    ),
    vscode.commands.registerCommand("ripieno.hostWorkspace", () => toggleWorkspaceHost()),
    vscode.commands.registerCommand("ripieno.mountWorkspace", () => mountSharedWorkspace()),
    vscode.commands.registerCommand("ripieno.proposeChange", () => proposeChange()),
    vscode.commands.registerCommand("ripieno.attachAgent", (node?: { id?: string }) =>
      void attachAgent(idFromNode(node))
    ),
    vscode.commands.registerCommand("ripieno.detachAgent", (node?: { id?: string }) =>
      detachAgent(idFromNode(node))
    ),
    approvals,
    { dispose: () => { stopWatching(); detachAll(); relay?.dispose(); } }
  );

  /** Tree item ids are prefixed so attached and detached rows stay distinct. */
  function idFromNode(node?: unknown): string | undefined {
    return agentIdFromTreeNode(node, me?.handle);
  }

  function myAgentsForTree(): MyAgent[] {
    return [...specs.values()].map((spec) => ({
      id: spec.id,
      label: labelFor(spec.label),
      state: agents.get(spec.id)?.currentState ?? "detached",
      refusal: agents.get(spec.id)?.refusal,
      failure: agents.get(spec.id)?.failure,
      folder: spec.cwd ? spec.cwd.split("/").pop() : undefined,
      model: spec.model,
      // The first agent answers anything not addressed to someone specific.
      primary: [...specs.keys()][0] === spec.id,
      capability: isWorkspaceProvider(spec.providerId) ? "workspace" : "conversation",
      provider: spec.providerId,
      permissions: describePermissions(spec),
    }));
  }

  function labelFor(base: string): string {
    return me ? `${me.displayName}'s ${base}` : base;
  }

  async function addAgent(): Promise<void> {
    const provider = await pickProvider();
    if (!provider) return;

    // Setup asks only for what the provider strictly needs. A general-purpose
    // agent gets a useful name, the open workspace and a safe trust boundary;
    // name, brief, folder, model and permissions all live behind its gear.
    const name = nextAgentLabel([...specs.values()].map((spec) => spec.label));
    let id = `local:agent:${Date.now().toString(36)}:${specs.size}`;
    while (specs.has(id)) id += ":next";

    let command: string | undefined;
    let args: string[] | undefined;

    if (provider.kind === "claude-code") {
      if (!(await commandExists("claude"))) {
        void vscode.window.showWarningMessage(
          "Claude Code is not available on this editor's PATH. Install and sign in to it, then add the agent again."
        );
        return;
      }
    } else if (provider.kind === "cli") {
      command = provider.command;
      if (!command) {
        command = await vscode.window.showInputBox({
          title: "Add Agent · Local command",
          prompt: "Executable to run. It must be on this editor's PATH.",
          placeHolder: "e.g. my-agent-cli",
          ignoreFocusOut: true,
        });
        if (!command) return;
      }

      if (provider.id === "codex") {
        // ChatGPT for macOS bundles Codex even when no `codex` alias reached
        // VS Code's PATH (GUI-launched editors often inherit a smaller PATH).
        // Store the working absolute executable so later turns behave exactly
        // like the readiness check did.
        command =
          (await firstAvailableCommand([
            command,
            ...(process.platform === "darwin"
              ? ["/Applications/ChatGPT.app/Contents/Resources/codex"]
              : []),
          ])) ?? command;
        if (!(await ensureCodexReady(command))) return;
      } else if (!(await commandExists(command))) {
        void vscode.window.showWarningMessage(
          `"${command}" is not available on this editor's PATH. Install and sign in to it, then add the agent again.`
        );
        return;
      }

      if (provider.id === "cli-custom") {
        const rawArgs = await vscode.window.showInputBox({
          title: "Add Agent · Command arguments",
          prompt:
            "Space-separated. {prompt} is replaced with the conversation; omit it to send the prompt on stdin.",
          value: "{prompt}",
          ignoreFocusOut: true,
        });
        if (rawArgs === undefined) return;
        args = rawArgs.split(/\s+/).filter(Boolean);
      } else {
        // Recommended presets are ready-to-run. Raw flags belong in the custom
        // path, not in every new user's onboarding.
        args = provider.args ?? ["{prompt}"];
      }
    }

    let model: string | undefined;
    let baseUrl: string | undefined;

    if (provider.kind === "openai-compatible") {
      baseUrl = provider.baseUrl;
      if (!baseUrl) {
        baseUrl = await vscode.window.showInputBox({
          title: `Endpoint for "${name}"`,
          prompt: "Base URL of an OpenAI-compatible API. /chat/completions is appended.",
          placeHolder: "https://api.example.com/v1",
          ignoreFocusOut: true,
          validateInput: (value) => {
            const checked = validateProviderBaseUrl(value);
            return checked.ok ? undefined : checked.reason;
          },
        });
        if (!baseUrl) return;
      }
      const checkedBaseUrl = validateProviderBaseUrl(baseUrl);
      if (!checkedBaseUrl.ok) {
        void vscode.window.showErrorMessage(`Ripieno: ${checkedBaseUrl.reason}.`);
        return;
      }
      baseUrl = checkedBaseUrl.url;
      model = await vscode.window.showInputBox({
        title: `Model for "${name}"`,
        prompt: `Model name as ${provider.label} expects it.`,
        value: provider.suggestedModel ?? "",
        ignoreFocusOut: true,
      });
      if (!model) return;

      const key = await vscode.window.showInputBox({
        title: `API key for "${name}"`,
        prompt: "Stored in the editor's secret storage, never in settings.",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      // SecretStorage, not settings: settings sync between machines and are
      // readable by anything that can read the file.
      await context.secrets.store(secretKeyFor(id), key);
    }

    specs.set(id, {
      id,
      label: name,
      model,
      providerId: provider.id,
      baseUrl,
      command,
      args,
      permissions: provider.kind === "openai-compatible" ? undefined : "workspace",
    });
    saveState({});
    roomsTree.setMyAgents(myAgentsForTree());

    if (currentRoom) {
      await attachAgent(id);
    }
    const status = currentRoom
      ? `${labelFor(name)} joined as a general-purpose agent.`
      : `${name} is ready and will attach when you join a room.`;
    const choice = await vscode.window.showInformationMessage(status, "Customize Agent…");
    if (choice === "Customize Agent…") await customizeAgent(id);
  }

  type AgentSetting = "name" | "brief" | "permissions" | "folder" | "model" | "delete";

  function describePermissions(spec: AgentSpecRecord): string {
    const kind = providerById(spec.providerId)?.kind;
    if (kind === "openai-compatible") return "conversation only";
    if (spec.providerId !== "codex" && kind === "cli") return "managed by CLI";

    const configured = spec.permissions;
    if (!configured) {
      if (kind === "claude-code") {
        const legacy = vscode.workspace
          .getConfiguration("ripieno")
          .get<string>("agentPermissions", "ask");
        return legacy === "bypassPermissions" ? "full access" : "asks for permission";
      }
      return "provider default";
    }
    if (configured === "full") return "full computer access";
    if (configured === "readOnly") return "read only";
    return spec.providerId === "codex" ? "workspace only" : "asks for permission";
  }

  async function agentToCustomize(id?: string): Promise<AgentSpecRecord | undefined> {
    if (id) return specs.get(id);
    if (specs.size === 0) {
      void vscode.window.showInformationMessage("Ripieno: add an agent first.");
      return undefined;
    }
    if (specs.size === 1) return [...specs.values()][0];

    type AgentItem = vscode.QuickPickItem & { spec: AgentSpecRecord };
    const picked = await vscode.window.showQuickPick<AgentItem>(
      [...specs.values()].map((spec) => ({
        label: labelFor(spec.label),
        description: providerById(spec.providerId)?.label ?? spec.providerId,
        detail: `${spec.brief ?? "General-purpose"} · ${describePermissions(spec)}`,
        spec,
      })),
      { title: "Customize Agent", placeHolder: "Choose one of your agents", ignoreFocusOut: true }
    );
    return picked?.spec;
  }

  async function customizeAgent(id?: string): Promise<void> {
    const spec = await agentToCustomize(id);
    if (!spec) return;

    type SettingItem = vscode.QuickPickItem & { setting: AgentSetting };
    const provider = providerById(spec.providerId);
    const settings: SettingItem[] = [
      {
        label: "$(edit) Name",
        description: spec.label,
        detail: "How people address this agent in the room",
        setting: "name",
      },
      {
        label: "$(note) Brief",
        description: spec.brief || "None — general-purpose",
        detail: "Optional standing instructions; you can add or remove them any time",
        setting: "brief",
      },
      {
        label: "$(shield) Permissions",
        description: describePermissions(spec),
        detail: "Change what this agent may do on your machine",
        setting: "permissions",
      },
      {
        label: "$(folder) Working folder",
        description: spec.cwd ?? "Current workspace",
        detail: "Choose which project this agent works in",
        setting: "folder",
      },
    ];
    if (supportsModelSelection(spec)) {
      settings.push({
        label: `$(symbol-method) ${modelSettingLabel(spec)}`,
        description: spec.model ?? "Provider default",
        detail: `Choose the model used by ${provider?.label ?? spec.providerId}`,
        setting: "model",
      });
    }
    settings.push({
      label: "$(trash) Delete agent…",
      description: "Remove it from Ripieno",
      detail: "Detaches the agent and forgets its saved session and credentials",
      setting: "delete",
    });

    const picked = await vscode.window.showQuickPick(settings, {
      title: `Customize ${labelFor(spec.label)}`,
      placeHolder: "Choose what to adjust",
      ignoreFocusOut: true,
    });
    if (!picked) return;

    if (picked.setting === "delete") {
      await removeAgent(spec.id);
      return;
    }

    if (picked.setting === "name") {
      const value = await vscode.window.showInputBox({
        title: `Rename ${labelFor(spec.label)}`,
        prompt: "This is how people and agents will address it in the room.",
        value: spec.label,
        ignoreFocusOut: true,
        validateInput: (raw) => {
          const name = raw.trim();
          if (!name) return "Enter a name for the agent.";
          if (name.length > 80) return "Keep the name to 80 characters or fewer.";
          if (
            [...specs.values()].some(
              (other) => other.id !== spec.id && other.label.toLocaleLowerCase() === name.toLocaleLowerCase()
            )
          ) {
            return "Each of your agents needs a distinct name.";
          }
          return undefined;
        },
      });
      if (value === undefined || value.trim() === spec.label) return;
      spec.label = value.trim();
      await persistAgentChange(spec, true);
      return;
    }

    if (picked.setting === "brief") {
      const value = await vscode.window.showInputBox({
        title: `Brief ${labelFor(spec.label)}`,
        prompt: "Leave empty for a normal, general-purpose agent.",
        placeHolder: "e.g. Review changes critically; do not write code",
        value: spec.brief ?? "",
        ignoreFocusOut: true,
        validateInput: (raw) =>
          raw.length > 2_000 ? "Keep the brief to 2,000 characters or fewer." : undefined,
      });
      if (value === undefined || value.trim() === (spec.brief ?? "")) return;
      spec.brief = value.trim() || undefined;
      await persistAgentChange(spec, true);
      return;
    }

    if (picked.setting === "folder") {
      const folder = await pickWorkingFolder(spec.label);
      if (!folder || folder.cwd === spec.cwd) return;
      spec.cwd = folder.cwd;
      await persistAgentChange(spec, true);
      return;
    }

    if (picked.setting === "model") {
      const model = await pickModelForAgent(spec);
      if (!model || model.model === spec.model) return;
      spec.model = model.model;
      await persistAgentChange(spec, true);
      return;
    }

    const permission = await pickAgentPermissions(spec);
    if (!permission || permission === spec.permissions) return;
    if (permission === "full" && spec.permissions !== "full") {
      const confirmed = await vscode.window.showWarningMessage(
        `Give ${labelFor(spec.label)} full computer access?`,
        {
          modal: true,
          detail:
            "This removes the sandbox or approval checks. Anyone who can speak in the room can steer this agent, so only enable it in a room and workspace you fully trust.",
        },
        "Enable Full Access"
      );
      if (confirmed !== "Enable Full Access") return;
    }
    spec.permissions = permission;
    await persistAgentChange(spec, false);
  }

  async function removeAgent(id?: string): Promise<void> {
    const spec = await agentToCustomize(id);
    if (!spec) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete ${labelFor(spec.label)}?`,
      {
        modal: true,
        detail:
          "This detaches the agent and permanently forgets its Ripieno brief, settings, saved session and stored API key. It does not delete project files.",
      },
      "Delete Agent"
    );
    if (confirmed !== "Delete Agent") return;

    const wasPrimary = [...specs.keys()][0] === spec.id;
    const restart = wasPrimary
      ? [...agents.keys()].filter((agentId) => agentId !== spec.id)
      : [];
    detachAgent(spec.id);
    for (const agentId of restart) detachAgent(agentId);
    specs.delete(spec.id);

    const sessions = { ...loadState().sessions };
    delete sessions[spec.id];
    await context.secrets.delete(secretKeyFor(spec.id));
    saveState({ sessions });
    roomsTree.setMyAgents(myAgentsForTree());
    for (const agentId of restart) await attachAgent(agentId);
    void vscode.window.showInformationMessage(`${labelFor(spec.label)} deleted.`);
  }

  async function pickAgentPermissions(
    spec: AgentSpecRecord
  ): Promise<AgentPermission | undefined> {
    type PermissionItem = vscode.QuickPickItem & { value: AgentPermission };
    let choices: PermissionItem[];
    if (spec.providerId === "codex") {
      choices = [
        {
          label: "$(shield) Workspace only",
          description: "Recommended",
          detail: "Can inspect and edit this project; access outside it is denied",
          value: "workspace",
        },
        {
          label: "$(lock) Read only",
          detail: "Can inspect the project and reply, but cannot edit files or run commands",
          value: "readOnly",
        },
        {
          label: "$(warning) Full computer access",
          detail: "No sandbox and no approval prompts — use only in a room you fully trust",
          value: "full",
        },
      ];
    } else if (providerById(spec.providerId)?.kind === "claude-code") {
      choices = [
        {
          label: "$(shield) Ask before side effects",
          description: "Recommended",
          detail: "File writes and commands are sent to you as approval cards",
          value: "workspace",
        },
        {
          label: "$(warning) Full computer access",
          detail: "Runs without asking — use only in a room you fully trust",
          value: "full",
        },
      ];
    } else {
      const message =
        providerById(spec.providerId)?.kind === "openai-compatible"
          ? `${labelFor(spec.label)} is conversation-only and cannot access local files through Ripieno.`
          : `${labelFor(spec.label)} uses a CLI whose permissions are controlled by that CLI's own configuration.`;
      void vscode.window.showInformationMessage(message);
      return undefined;
    }
    return (
      await vscode.window.showQuickPick(choices, {
        title: `Permissions for ${labelFor(spec.label)}`,
        placeHolder: `Current: ${describePermissions(spec)}`,
        ignoreFocusOut: true,
      })
    )?.value;
  }

  async function persistAgentChange(
    spec: AgentSpecRecord,
    freshSession: boolean,
    announce = true
  ): Promise<boolean> {
    const wasAttached = agents.has(spec.id);
    if (wasAttached) detachAgent(spec.id);

    if (freshSession) {
      const sessions = { ...loadState().sessions };
      delete sessions[spec.id];
      saveState({ sessions });
    } else {
      saveState({});
    }
    roomsTree.setMyAgents(myAgentsForTree());
    if (wasAttached) await attachAgent(spec.id);
    if (announce) {
      void vscode.window.showInformationMessage(
        `${labelFor(spec.label)} updated${wasAttached ? " and restarted" : ""}.`
      );
    }
    return wasAttached;
  }

  /**
   * Point the filesystem at whoever is hosting.
   *
   * Someone else's workspace is browsable; your own is already in the Explorer,
   * so mounting it again would be confusing rather than useful.
   */
  function applyWorkspaceHost(host: string | undefined): void {
    // Only the host watches: everyone else's disk is irrelevant to the room.
    if (host && host === me?.handle) startWatching();
    else stopWatching();

    const someoneElse = host && host !== me?.handle ? host : undefined;
    workspaceTree.setHost(someoneElse);
    workspaceFs.setRemote(
      someoneElse
        ? async (name, input) => {
            const requestId = `fs_${nextFsRequest++}`;
            return remoteToolCall(requestId, name, input);
          }
        : undefined
    );
    void vscode.commands.executeCommand("setContext", "ripieno.hasSharedWorkspace", Boolean(someoneElse));
  }

  /**
   * Issue a remote tool call on behalf of the editor rather than an agent.
   *
   * The relay only routes remote tools for agent connections, so this rides the
   * member's own agent identity — the browsing is attributed to the person, via
   * their agent, which is what the action log should record anyway.
   */
  function remoteToolCall(
    requestId: string,
    name: string,
    input: Record<string, unknown>
  ): Promise<{ content: string; isError: boolean }> {
    const browser = [...agents.values()][0];
    if (!browser) {
      return Promise.resolve({
        content:
          "Browsing a shared workspace needs one of your agents attached — it carries the identity the request is made under.",
        isError: true,
      });
    }
    return browser.remoteTool(requestId, name, input);
  }

  /**
   * Offer this machine as the room's shared workspace, or stop.
   *
   * Worth a confirmation the first time: hosting means other members' agents can
   * read, write and run things here — with your approval each time, but the
   * reach is real and should be a deliberate choice rather than a toggle.
   */
  async function toggleWorkspaceHost(): Promise<void> {
    if (!relay || !currentRoom) {
      vscode.window.showInformationMessage("Ripieno: join a room first.");
      return;
    }
    if (hostingWorkspace) {
      relay.send({ t: "claimWorkspace", claim: false });
      hostingWorkspace = false;
      return;
    }
    const go = await vscode.window.showWarningMessage(
      "Host this room's shared workspace?",
      {
        modal: true,
        detail:
          "Other members' agents will be able to read, write and run commands in this folder. " +
          "Each action still asks your approval, and the room records which agent did what.",
      },
      "Host the workspace"
    );
    if (go !== "Host the workspace") return;
    relay.send({ t: "claimWorkspace", claim: true });
    hostingWorkspace = true;
  }

  /**
   * Put the shared workspace in the real Explorer.
   *
   * Opt-in rather than automatic: changing workspace folders can restart the
   * extension host, which would drop every attached agent mid-room.
   */
  async function mountSharedWorkspace(): Promise<void> {
    const host = workspaceTree.hostHandle;
    if (!host) {
      vscode.window.showInformationMessage("Ripieno: nobody is hosting a shared workspace.");
      return;
    }
    const go = await vscode.window.showWarningMessage(
      `Add @${host}'s workspace to the Explorer?`,
      {
        modal: true,
        detail:
          "VS Code may reload the window to add a folder, which detaches your agents. They can be reattached afterwards.",
      },
      "Add to Explorer"
    );
    if (go !== "Add to Explorer") return;

    vscode.workspace.updateWorkspaceFolders(
      vscode.workspace.workspaceFolders?.length ?? 0,
      0,
      { uri: uriFor(""), name: `${host} (shared)` }
    );
  }

  /**
   * Send the active editor's contents to the host as a proposed change.
   *
   * Deliberately explicit rather than save-through: VS Code saves eagerly, so
   * transparent writes would mean an approval prompt on someone else's machine
   * every time a buffer autosaved.
   */
  async function proposeChange(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Ripieno: open a file to propose a change.");
      return;
    }
    const host = workspaceTree.hostHandle;
    if (!host) {
      vscode.window.showInformationMessage("Ripieno: nobody is hosting a shared workspace.");
      return;
    }

    // A host document already knows its path; a local file has to be told where
    // it belongs in the host's tree, since the layouts need not match.
    const suggested = isHostDocument(editor.document)
      ? editor.document.uri.path.replace(/^\//, "")
      : vscode.workspace.asRelativePath(editor.document.uri, false);

    const target = await vscode.window.showInputBox({
      title: `Propose a change to @${host}`,
      prompt: "Path in their workspace",
      value: suggested,
      ignoreFocusOut: true,
    });
    if (!target) return;

    const result = await remoteToolCall(`fs_${nextFsRequest++}`, "write_file", {
      path: target,
      content: editor.document.getText(),
    });
    void vscode.window.showInformationMessage(
      result.isError
        ? `Ripieno: ${result.content}`
        : `Sent to @${host} — they decide whether to apply it.`
    );
  }

  interface CommandProbe {
    found: boolean;
    code: number | null;
    output: string;
  }

  /** Run a bounded, non-interactive readiness check without invoking a shell. */
  function probeCommand(command: string, args: string[], timeoutMs = 8_000): Promise<CommandProbe> {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const child = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const finish = (result: CommandProbe) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill();
        finish({ found: true, code: null, output });
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString()));
      child.on("error", () => finish({ found: false, code: null, output }));
      child.on("close", (code) => finish({ found: true, code, output }));
    });
  }

  /** Is this executable available to the extension host on every desktop OS? */
  async function commandExists(command: string): Promise<boolean> {
    return (await probeCommand(command, ["--version"])).found;
  }

  async function firstAvailableCommand(candidates: readonly string[]): Promise<string | undefined> {
    for (const candidate of candidates) {
      if (await commandExists(candidate)) return candidate;
    }
    return undefined;
  }

  async function codexIsReady(command: string): Promise<boolean> {
    const status = await probeCommand(command, ["login", "status"]);
    return status.found && isCodexLoginReady(status.code, status.output);
  }

  async function waitForCodexLogin(
    command: string,
    token: vscode.CancellationToken
  ): Promise<boolean> {
    const deadline = Date.now() + 5 * 60_000;
    while (!token.isCancellationRequested && Date.now() < deadline) {
      if (await codexIsReady(command)) return true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    return false;
  }

  /**
   * ChatGPT is used through Codex CLI. Installation and login happen in the
   * provider's own trusted flow; Ripieno checks the result before saving an
   * agent, so an unconfigured account never enters the room as a broken bot.
   */
  async function ensureCodexReady(command: string): Promise<boolean> {
    if (!(await commandExists(command))) {
      const choice = await vscode.window.showWarningMessage(
        "Codex CLI is needed to use your ChatGPT account in Ripieno.",
        { modal: true, detail: "Install Codex from OpenAI's guide, then choose Add Agent again." },
        "Open setup guide"
      );
      if (choice === "Open setup guide") {
        await vscode.env.openExternal(vscode.Uri.parse(CODEX_SETUP_URL));
      }
      return false;
    }

    if (await codexIsReady(command)) return true;

    const choice = await vscode.window.showInformationMessage(
      "Codex is installed, but it is not signed in.",
      {
        modal: true,
        detail:
          "Sign in with ChatGPT in a terminal. Ripieno will verify the login and continue automatically.",
      },
      "Sign in with ChatGPT",
      "Open setup guide"
    );
    if (choice === "Open setup guide") {
      await vscode.env.openExternal(vscode.Uri.parse(CODEX_SETUP_URL));
      return false;
    }
    if (choice !== "Sign in with ChatGPT") return false;

    const terminal = vscode.window.createTerminal({ name: "Ripieno · ChatGPT sign in" });
    terminal.show();
    // Both values come from the fixed Codex preset/known app path, never from a
    // webview message. Quote the app path in case a future installation path
    // contains spaces.
    const loginCommand = command === "codex" ? "codex login" : `"${command}" login`;
    terminal.sendText(loginCommand, true);
    const ready = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Ripieno: waiting for ChatGPT sign-in…",
        cancellable: true,
      },
      (_progress, token) => waitForCodexLogin(command, token)
    );
    if (!ready) {
      void vscode.window.showWarningMessage(
        "ChatGPT sign-in was not detected. Finish signing in, then choose Add Agent again."
      );
    }
    return ready;
  }

  /**
   * Which model provider runs this agent.
   *
   * The room is provider-agnostic, so a Grok or Kimi agent participates on the
   * same terms as a Claude one — except for file access, which only a local
   * Claude Code agent has. The picker says so rather than leaving it implied.
   */
  async function pickProvider(): Promise<ProviderPreset | undefined> {
    type ProviderItem = vscode.QuickPickItem & { preset?: ProviderPreset };
    const item = (preset: ProviderPreset): ProviderItem => ({
      label: preset.id === "codex" ? `$(sparkle) ${preset.label}` : preset.label,
      description: preset.id === "codex" ? "Recommended" : undefined,
      detail: preset.hint,
      preset,
    });
    const byId = (id: string) => PROVIDERS.find((provider) => provider.id === id);
    const codex = byId("codex");
    const local = [byId("claude-code"), byId("gemini"), byId("cli-custom")].filter(
      (provider): provider is ProviderPreset => Boolean(provider)
    );
    const api = PROVIDERS.filter(
      (provider) => provider.kind === "openai-compatible"
    );
    const items: ProviderItem[] = [
      { label: "Uses an account you already have", kind: vscode.QuickPickItemKind.Separator },
      ...(codex ? [item(codex)] : []),
      ...local.map(item),
      { label: "API or local endpoint", kind: vscode.QuickPickItemKind.Separator },
      ...api.map(item),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Add Agent · Choose what powers it",
      placeHolder: "ChatGPT / Codex is the easiest way to start",
      ignoreFocusOut: true,
    });
    return picked?.preset;
  }

  type ModelPick = vscode.QuickPickItem & {
    choice: "default" | "model" | "custom";
    value?: string;
  };

  function supportsModelSelection(spec: AgentSpecRecord): boolean {
    const kind = providerById(spec.providerId)?.kind;
    return (
      kind === "claude-code" ||
      kind === "openai-compatible" ||
      spec.providerId === "codex" ||
      spec.providerId === "gemini"
    );
  }

  function modelSettingLabel(spec: AgentSpecRecord): string {
    if (spec.providerId === "codex") return "Codex model";
    if (spec.providerId === "gemini") return "Gemini model";
    if (spec.providerId === "claude-code") return "Claude model";
    return "Model";
  }

  async function pickModelForAgent(
    spec: AgentSpecRecord
  ): Promise<{ model?: string } | undefined> {
    if (spec.providerId === "codex") return pickCodexModel(spec);
    if (spec.providerId === "gemini") {
      return pickKnownOrCustomModel(spec, [
        { label: "$(gear) Provider default", detail: "Use Gemini CLI's configured default", choice: "default" },
        { label: "Auto", detail: "Let Gemini route to an appropriate available model", choice: "model", value: "auto" },
        { label: "Pro", detail: "Gemini CLI's current Pro alias", choice: "model", value: "pro" },
        { label: "Flash", detail: "Gemini CLI's current fast alias", choice: "model", value: "flash" },
        { label: "Flash Lite", detail: "Gemini CLI's fastest alias", choice: "model", value: "flash-lite" },
        { label: "$(edit) Enter exact model ID…", choice: "custom" },
      ]);
    }
    if (spec.providerId === "claude-code") {
      return pickKnownOrCustomModel(spec, [
        { label: "$(gear) Provider default", detail: "Use Claude Code's configured default", choice: "default" },
        { label: "$(sparkle) Opus", detail: "Claude Code's Opus alias", choice: "model", value: "opus" },
        { label: "$(zap) Sonnet", detail: "Claude Code's Sonnet alias", choice: "model", value: "sonnet" },
        { label: "$(dashboard) Haiku", detail: "Claude Code's Haiku alias", choice: "model", value: "haiku" },
        { label: "$(edit) Enter exact model ID…", choice: "custom" },
      ]);
    }

    const provider = providerById(spec.providerId);
    if (provider?.kind === "openai-compatible") {
      return inputExactModel(spec, provider.suggestedModel);
    }
    void vscode.window.showInformationMessage(
      `${labelFor(spec.label)} uses a custom CLI. Set its model in that CLI's arguments or configuration.`
    );
    return undefined;
  }

  async function pickKnownOrCustomModel(
    spec: AgentSpecRecord,
    choices: ModelPick[]
  ): Promise<{ model?: string } | undefined> {
    const picked = await vscode.window.showQuickPick(choices, {
      title: `${modelSettingLabel(spec)} for ${labelFor(spec.label)}`,
      placeHolder: `Current: ${spec.model ?? "provider default"}`,
      ignoreFocusOut: true,
    });
    if (!picked) return undefined;
    if (picked.choice === "default") return { model: undefined };
    if (picked.choice === "custom") return inputExactModel(spec);
    return { model: picked.value };
  }

  async function pickCodexModel(
    spec: AgentSpecRecord
  ): Promise<{ model?: string } | undefined> {
    const command = spec.command ?? "codex";
    let result = await probeCommand(command, ["debug", "models"], 10_000);
    let catalog = result.code === 0 ? parseCodexModelCatalog(result.output) : [];
    if (catalog.length === 0) {
      result = await probeCommand(command, ["debug", "models", "--bundled"], 10_000);
      catalog = result.code === 0 ? parseCodexModelCatalog(result.output) : [];
    }

    const choices: ModelPick[] = [
      {
        label: "$(gear) Provider default",
        detail: "Use the model configured by Codex",
        choice: "default",
      },
      ...catalog.map((model) => ({
        label: model.label,
        description: model.slug,
        detail: model.description,
        choice: "model" as const,
        value: model.slug,
      })),
      { label: "$(edit) Enter exact model ID…", choice: "custom" },
    ];
    return pickKnownOrCustomModel(spec, choices);
  }

  async function inputExactModel(
    spec: AgentSpecRecord,
    fallback?: string
  ): Promise<{ model?: string } | undefined> {
    const value = await vscode.window.showInputBox({
      title: `${modelSettingLabel(spec)} for ${labelFor(spec.label)}`,
      prompt: "Enter the exact model ID accepted by this provider.",
      value: spec.model ?? fallback ?? "",
      ignoreFocusOut: true,
      validateInput: (raw) => {
        const parsed = parseModelValue(raw);
        return parsed.ok ? undefined : parsed.message;
      },
    });
    return value === undefined ? undefined : { model: value.trim() };
  }

  /**
   * Room-level commands. `/model` and friends never reach a headless agent —
   * the interactive CLI owns that layer — so the room provides its own, handled
   * here rather than posted into the conversation for a model to puzzle over.
   * Returns true when the message was a command and should not be sent.
   */
  function handleRoomCommand(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;

    const [command, ...rest] = trimmed.slice(1).split(/\s+/);
    const argument = rest.join(" ").trim();

    switch (command.toLowerCase()) {
      case "help":
        note(
          [
            "Room commands (handled here, not sent to the room):",
            "  /model                         — choose an agent and one of its provider's models",
            "  /model <model> [agent]         — set an exact model; default clears the override",
            "  /agents                        — list your agents, providers, models and states",
            "  /attach [agent]                — attach one of your agents",
            "  /detach [agent]                — detach one of your agents",
            "  /help                          — this list",
          ].join("\n")
        );
        return true;

      case "agents": {
        const rows = [...specs.values()].map((spec) => {
          const state = agents.get(spec.id)?.currentState ?? "detached";
          const where = spec.cwd ? ` · ${spec.cwd}` : "";
          const provider = providerById(spec.providerId)?.label.replace(" (local)", "") ?? spec.providerId;
          return `  ${labelFor(spec.label)} — ${state} · ${provider} · ${spec.model ?? "provider default"}${where}`;
        });
        note(rows.length > 0 ? `Your agents:\n${rows.join("\n")}` : "You have no agents.");
        return true;
      }

      case "model":
        void changeModelFromCommand(argument);
        return true;

      case "attach":
        void attachFromCommand(argument);
        return true;

      case "detach":
        void detachFromCommand(argument);
        return true;

      default:
        note(`Unknown command "/${command}". Try /help.`);
        return true;
    }
  }

  async function changeModelFromCommand(argument: string): Promise<void> {
    const request = resolveModelRequest(argument, [...specs.values()]);
    if (request.kind === "error") {
      note(request.message);
      return;
    }

    let spec = request.targetId ? specs.get(request.targetId) : undefined;
    if (request.kind === "pick" && !spec) {
      spec = await pickCommandAgent([...specs.values()], "Choose an agent to change");
    }
    if (!spec) return;

    if (request.kind === "pick") {
      const picked = await pickModelForAgent(spec);
      if (!picked) return;
      await setAgentModel(spec, picked.model);
      return;
    }
    await setAgentModel(spec, request.model);
  }

  async function setAgentModel(spec: AgentSpecRecord, model?: string): Promise<void> {
    if (!supportsModelSelection(spec)) {
      note(
        `${labelFor(spec.label)} uses a custom CLI. Set its model in that CLI's arguments or configuration.`
      );
      return;
    }
    if (providerById(spec.providerId)?.kind === "openai-compatible" && !model) {
      note(`${labelFor(spec.label)} needs an explicit model name; this endpoint has no shared default.`);
      return;
    }
    if (spec.model === model) {
      note(`${labelFor(spec.label)} already uses ${model ?? "its provider default"}.`);
      return;
    }

    spec.model = model;
    const restarted = await persistAgentChange(spec, true, false);
    note(
      `${labelFor(spec.label)} now uses ${model ?? "its provider default"}` +
        (restarted ? " (restarted with a fresh session)." : ".")
    );
  }

  async function attachFromCommand(argument: string): Promise<void> {
    if (specs.size === 0) {
      await addAgent();
      return;
    }
    const available = [...specs.values()].filter((spec) => {
      const host = agents.get(spec.id);
      return !host || host.currentState === "error" || host.currentState === "refused";
    });
    const spec = await pickCommandAgent(available, "Choose an agent to attach", argument);
    if (!spec) {
      if (specs.size > 0 && available.length === 0) note("All of your agents are already attached.");
      return;
    }
    await attachAgent(spec.id);
    note(`Attaching ${labelFor(spec.label)}.`);
  }

  async function detachFromCommand(argument: string): Promise<void> {
    const attached = [...specs.values()].filter((spec) => agents.has(spec.id));
    const spec = await pickCommandAgent(attached, "Choose an agent to detach", argument);
    if (!spec) {
      if (attached.length === 0) note("None of your agents are attached.");
      return;
    }
    detachAgent(spec.id);
    note(`Detached ${labelFor(spec.label)}.`);
  }

  async function pickCommandAgent(
    choices: AgentSpecRecord[],
    title: string,
    query = ""
  ): Promise<AgentSpecRecord | undefined> {
    let matching = choices;
    if (query.trim()) {
      const wanted = query.trim().toLocaleLowerCase();
      const exact = choices.find((spec) => spec.label.toLocaleLowerCase() === wanted);
      matching = exact
        ? [exact]
        : choices.filter((spec) => spec.label.toLocaleLowerCase().includes(wanted));
      if (matching.length === 0) {
        note(`No agent matching "${query.trim()}".`);
        return undefined;
      }
    }
    if (matching.length === 0) return undefined;
    if (matching.length === 1) return matching[0];

    type AgentItem = vscode.QuickPickItem & { spec: AgentSpecRecord };
    return (
      await vscode.window.showQuickPick<AgentItem>(
        matching.map((spec) => ({
          label: labelFor(spec.label),
          description: providerById(spec.providerId)?.label ?? spec.providerId,
          detail: `${spec.model ?? "Provider default"} · ${agents.get(spec.id)?.currentState ?? "detached"}`,
          spec,
        })),
        { title, ignoreFocusOut: true }
      )
    )?.spec;
  }

  /** Local-only feedback: shown to you, not broadcast to the room. */
  function note(text: string): void {
    roomView.addEntry({
      id: `local_${Date.now()}`,
      kind: "system",
      authorHandle: "system",
      authorName: "system",
      text,
      ts: Date.now(),
    });
  }

  /**
   * Which project this agent works in. Defaulting to the editor's workspace is
   * right most of the time, but an agent can be pointed at a different — or
   * brand-new — directory, so one room can span several projects.
   */
  async function pickWorkingFolder(
    name: string
  ): Promise<{ cwd?: string } | undefined> {
    const here = vscode.workspace.workspaceFolders?.[0];
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: here ? `$(folder) ${here.name}` : "$(folder) This workspace",
          description: "the folder open in this window",
          picked: true,
        },
        {
          label: "$(folder-opened) Choose a folder…",
          description: "another project — create a new folder in the dialog if you need one",
        },
      ],
      { title: `Where should "${name}" work?`, ignoreFocusOut: true }
    );
    if (!choice) return undefined;
    if (choice.label.startsWith("$(folder) ")) return {};

    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: `Use as ${name}'s project`,
      title: `Working folder for "${name}"`,
    });
    return picked?.[0] ? { cwd: picked[0].fsPath } : undefined;
  }

  /**
   * Attaching starts a real process, which is what makes dragging an agent into
   * a room meaningful rather than a picture of state you created by hand.
   */
  async function attachAgent(id?: string): Promise<void> {
    const spec = id ? specs.get(id) : [...specs.values()][0];
    // The room's empty-state button means "get me an agent", whether one has
    // already been configured or not. Falling through to setup removes the
    // old no-op that made a first-time user's most obvious button do nothing.
    if (!spec) {
      if (shouldStartAddAgentForAttach(specs.size, id)) await addAgent();
      return;
    }
    if (!currentRoom || !me) {
      vscode.window.showInformationMessage("Ripieno: join a room first.");
      return;
    }
    const consentKey = `${activeRelayUrl ?? ""}\0${currentRoom}\0${spec.id}`;
    if (
      needsSharedRoomAgentConsent(
        isWorkspaceProvider(spec.providerId),
        activeRelayUrl,
        solo.address,
        currentRoom,
        sharedRoomAgentConsent.has(consentKey)
      )
    ) {
      const choice = await vscode.window.showWarningMessage(
        `Attach ${labelFor(spec.label)} to this shared room?`,
        {
          modal: true,
          detail:
            `Everyone in "${currentRoom}" can prompt this local agent. ` +
            `Its configured provider permissions may let it read, edit, or run code in ` +
            `${spec.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "this editor's workspace"}. ` +
            "Attach it only if you trust the room with that access.",
        },
        "Attach Agent"
      );
      if (choice !== "Attach Agent") return;
      sharedRoomAgentConsent.add(consentKey);
    }
    const existing = agents.get(spec.id);
    if (existing) {
      // A refused agent keeps its host, because that host is what remembers why
      // and shows it in the tree — but the host itself is finished, since
      // RelayClient does not retry a 4003. Attaching again therefore has to
      // build a new one; returning here would make the tree offer an action
      // that silently does nothing.
      if (existing.currentState !== "refused" && existing.currentState !== "error") return;
      existing.dispose();
      agents.delete(spec.id);
    }

    // The first agent a member creates answers anything not addressed to
    // someone specific; the rest speak only when named. Exactly one primary per
    // member is what keeps three agents from all replying to one question.
    const isPrimary = [...specs.keys()][0] === spec.id;

    const apiKey =
      providerById(spec.providerId)?.kind === "openai-compatible"
        ? await context.secrets.get(secretKeyFor(spec.id))
        : undefined;

    const host = new AgentHost({
      url: relayUrl(),
      room: currentRoom,
      member: me,
      githubToken,
      id: spec.id,
      label: labelFor(spec.label),
      brief: spec.brief,
      cwd: spec.cwd,
      model: spec.model,
      providerId: spec.providerId,
      baseUrl: spec.baseUrl,
      command: spec.command,
      args: spec.args,
      permissions: spec.permissions,
      apiKey,
      resumeSessionId: loadState().sessions[spec.id],
      onSession: (agentId, sessionId) =>
        saveState({ sessions: { ...loadState().sessions, [agentId]: sessionId } }),
      primary: isPrimary,
      siblingLabels: [...specs.values()]
        .filter((other) => other.id !== spec.id)
        .map((other) => labelFor(other.label)),
      approvals,
      permissionServerPath,
      workspaceServerPath,
      token: roomToken(),
      onStateChange: (agentId, state) => onAgentState(agentId, state),
    });
    agents.set(spec.id, host);
    host.attach();
    roomsTree.setMyAgents(myAgentsForTree());
  }

  function detachAgent(id?: string): void {
    const target = id ?? [...agents.keys()][0];
    if (!target) return;
    agents.get(target)?.dispose();
    agents.delete(target);
    roomsTree.setMyAgents(myAgentsForTree());
  }

  /**
   * While hosting, publish our own file changes.
   *
   * The action log only records work routed through the room, so an agent using
   * its own local tools — or the host saving a file in the editor — left every
   * other member reading a stale cache with nothing to tell them. Watching the
   * filesystem catches both, and is the only thing that can.
   */
  function startWatching(): void {
    if (watcher) return;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;

    watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folder, "**/*")
    );
    const note = (uri: vscode.Uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      // Build output and dependencies churn constantly and nobody browses them;
      // publishing every write during `npm install` would be pure noise.
      if (/(^|\/)(node_modules|\.git|dist|out|build)(\/|$)/.test(rel)) return;
      changedPaths.add(rel);
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = setTimeout(publishChanges, 400);
    };
    watcher.onDidCreate(note);
    watcher.onDidChange(note);
    watcher.onDidDelete(note);
  }

  function publishChanges(): void {
    publishTimer = undefined;
    if (changedPaths.size === 0) return;
    // Cap the burst: a large checkout would otherwise send a huge frame, and
    // past a point the useful signal is "a lot changed" rather than the list.
    const paths = [...changedPaths].slice(0, 200);
    changedPaths.clear();
    relay?.send({ t: "workspaceChanged", paths });
  }

  function stopWatching(): void {
    watcher?.dispose();
    watcher = undefined;
    if (publishTimer) clearTimeout(publishTimer);
    publishTimer = undefined;
    changedPaths.clear();
  }

  function detachAll(): void {
    for (const host of agents.values()) host.dispose();
    agents.clear();
  }

  function onAgentState(_id: string, _state: AgentState): void {
    roomsTree.setMyAgents(myAgentsForTree());
  }

  /**
   * The room's shared secret.
   *
   * SecretStorage first, settings second. An invite link puts it in the former —
   * a token in settings.json is one `git add .` from being published, which is
   * how shared secrets usually escape — but the setting stays supported so
   * anyone already using it is not broken by this.
   */
  async function loadRoomToken(url: string, allowFirstUseLegacy = false): Promise<void> {
    cachedRoomToken = await context.secrets.get(roomTokenSecretKey(url));
    if (cachedRoomToken) return;

    const savedRelayUrl = loadState().relayUrl;
    if (!canUseLegacyRoomToken(savedRelayUrl, url, allowFirstUseLegacy)) return;

    const stored = await context.secrets.get(LEGACY_ROOM_TOKEN_SECRET);
    const configured = vscode.workspace
      .getConfiguration("ripieno")
      .get<string>("roomToken", "")
      .trim();
    cachedRoomToken = stored || configured || undefined;
    if (cachedRoomToken) {
      await context.secrets.store(roomTokenSecretKey(url), cachedRoomToken);
      if (stored) await context.secrets.delete(LEGACY_ROOM_TOKEN_SECRET);
    }
  }

  function roomToken(): string | undefined {
    return cachedRoomToken;
  }

  /**
   * Where the room lives.
   *
   * Empty configuration means solo: the extension runs a relay on loopback and
   * uses that. It is the same relay a team shares, so nothing about how the room
   * behaves changes when a second person arrives — only the URL does.
   */
  async function ensureRelayUrl(): Promise<string | undefined> {
    const configured = vscode.workspace
      .getConfiguration("ripieno")
      .get<string>("relayUrl", "")
      .trim();
    if (configured) {
      const checked = validateRelayUrl(configured);
      if (!checked.ok) {
        activeRelayUrl = undefined;
        void vscode.window.showErrorMessage(`Ripieno: ${checked.reason}.`);
        return undefined;
      }
      activeRelayUrl = checked.url;
      return checked.url;
    }
    activeRelayUrl = await solo.start(context.globalStorageUri.fsPath);
    return activeRelayUrl;
  }

  /**
   * Bring back the room and the agents this window had before it reloaded.
   *
   * Offered rather than done: rejoining posts "X joined the room" to everyone,
   * and doing that unasked every time an extension host restarts — which VS Code
   * does on its own schedule — would fill a shared room with noise nobody
   * caused.
   */
  async function restoreSession(): Promise<void> {
    // The agents themselves are restored during activation — see above. Only
    // rejoining the room is deferred to here, because only that is a question.
    const saved = loadState();
    roomsTree.setMyAgents(myAgentsForTree());
    if (!saved.room) return;

    const choice = await vscode.window.showInformationMessage(
      `Rejoin "${saved.room}"?`,
      "Rejoin",
      "Not now"
    );
    if (choice === "Rejoin") await connect(saved.room);
  }

  /**
   * Somebody clicked a link to join a room.
   *
   * Confirmed first, always. The link carries a server address and usually a
   * shared secret, and clicking it should not be the first time you learn where
   * you are connecting — links get forwarded, and this one is arriving from a
   * browser rather than from anyone we trust.
   */
  async function handleInvite(uri: vscode.Uri): Promise<void> {
    if (uri.path !== "/join") return;
    const parsed = parseInvite(uri.query);
    if (!parsed.ok) {
      void vscode.window.showErrorMessage(`Ripieno: ${parsed.reason}.`);
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      describeInvite(parsed.invite),
      { modal: true },
      "Join"
    );
    if (choice !== "Join") return;

    const config = vscode.workspace.getConfiguration("ripieno");
    await config.update("relayUrl", parsed.invite.relayUrl, vscode.ConfigurationTarget.Global);
    // Into SecretStorage rather than settings: a token in settings.json is one
    // `git add .` away from being published, which is how shared secrets usually
    // escape.
    if (parsed.invite.token) {
      await context.secrets.store(
        roomTokenSecretKey(parsed.invite.relayUrl),
        parsed.invite.token
      );
    }
    await connect(parsed.invite.room, false);
  }

  /**
   * Who you are when working alone and not signed in.
   *
   * Only ever used against a relay we started ourselves. Sharing a room needs a
   * real identity — other people have to know who is speaking, and the whole
   * provenance argument rests on it — but a room of one has nobody to convince,
   * and demanding a sign-in there is a barrier for no benefit.
   */
  function localIdentity(mustProve: boolean): { member: Member; githubToken?: string } | undefined {
    // A relay that verifies will refuse this anyway; better to say so here than
    // to be evicted a moment later with a less useful message.
    if (mustProve) return undefined;
    const name = os.userInfo().username || "you";
    return { member: { handle: name, displayName: name } };
  }

  /** The URL actually in use, once a room has been joined. */
  function relayUrl(): string {
    return activeRelayUrl ?? "ws://127.0.0.1:8787";
  }

  async function joinRoom(): Promise<void> {
    const room = await vscode.window.showInputBox({
      title: "Join Ripieno Room",
      prompt: "Room code",
      placeHolder: "e.g. tgtbt-standup",
      ignoreFocusOut: true,
    });
    if (!room) {
      return;
    }
    await connect(room);
  }

  /**
   * A link that puts somebody else in this room.
   *
   * Refused for a solo room: the URL is loopback, so the link would work only on
   * this machine and would look broken to whoever received it. Saying that is
   * more useful than handing over something that cannot work.
   */
  async function copyInvite(): Promise<void> {
    if (!currentRoom || !activeRelayUrl) {
      void vscode.window.showWarningMessage("Ripieno: join a room first.");
      return;
    }
    if (activeRelayUrl === solo.address) {
      // A notification truncates, and the half worth reading is what to do next
      // — so it goes on a button rather than at the end of a sentence nobody
      // sees. The first clause has to carry the whole meaning on its own.
      const choice = await vscode.window.showWarningMessage(
        "This room is on your machine — a link to it would not reach anyone else.",
        "Set a relay URL"
      );
      if (choice) {
        await vscode.commands.executeCommand("workbench.action.openSettings", "ripieno.relayUrl");
      }
      return;
    }

    const link = buildInvite(
      { relayUrl: activeRelayUrl, room: currentRoom, token: roomToken() },
      context.extension.id,
      // Whatever this editor actually registers — vscode, cursor, antigravity…
      vscode.env.uriScheme
    );
    await vscode.env.clipboard.writeText(link);
    const message = roomToken()
      ? "Invite link copied — it contains this room's token, so share it like a password."
      : "Invite link copied.";
    if (specs.size === 0) {
      const next = await vscode.window.showInformationMessage(message, "Add an agent");
      if (next === "Add an agent") await addAgent();
    } else {
      void vscode.window.showInformationMessage(message);
    }
  }

  /**
   * Change what somebody may do in this room.
   *
   * The rule lived in the relay with tests covering it and no way for anyone to
   * exercise it — `viewer` was a role the product could enforce and nobody could
   * assign. The relay still decides: this only asks.
   */
  async function setRole(node?: unknown): Promise<void> {
    // Two ways in: the member's row in the tree, or the command palette. The
    // palette used to arrive with no node and return silently, so the one
    // remaining route to a feature the relay fully enforces did nothing at all
    // and said nothing about it.
    const entry = (node as { entry?: RosterEntry } | undefined)?.entry ?? (await pickMember());
    if (!entry) return;

    const choice = await vscode.window.showQuickPick(
      [
        { label: "Member", value: "member" as const, description: "Post, attach agents, host the workspace" },
        { label: "Viewer", value: "viewer" as const, description: "Read the room and browse files only" },
        { label: "Owner", value: "owner" as const, description: "Everything, including changing roles" },
      ],
      { title: `Role for ${entry.displayName}`, placeHolder: `Currently ${entry.role ?? "member"}` }
    );
    if (!choice) return;
    relay?.send({ t: "setRole", handle: entry.handle, role: choice.value });
  }

  /**
   * Who to change the role of, when the command arrived from the palette.
   *
   * Says why it cannot proceed rather than doing nothing, which is what it did
   * before: not in a room, not the owner, or nobody else here are three quite
   * different situations and silence is indistinguishable from a broken build.
   */
  async function pickMember(): Promise<RosterEntry | undefined> {
    if (!currentRoom) {
      void vscode.window.showInformationMessage("Join a room before changing anyone's role.");
      return undefined;
    }
    const members = roomsTree.manageableMembers();
    if (members.length === 0) {
      void vscode.window.showInformationMessage(
        "Only the room's owner can change roles, and not their own."
      );
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      members.map((entry) => ({
        label: entry.displayName,
        description: `@${entry.handle} · ${entry.role ?? "member"}`,
        entry,
      })),
      { title: "Change role", placeHolder: "Whose role?" }
    );
    return picked?.entry;
  }

  /** Everything joining a room does, however the room code arrived. */
  async function connect(room: string, allowFirstUseLegacy = true): Promise<void> {
    const url = await ensureRelayUrl();
    if (!url) return;
    await loadRoomToken(url, allowFirstUseLegacy);

    // Only ask to sign in where the answer is actually checked.
    //
    // The relay says whether it verifies identity, so the prompt appears there
    // and nowhere else. Anywhere else — solo, or a relay that does not verify —
    // we take whatever is already to hand: an existing GitHub session if there
    // is one, a local name otherwise. Prompting on a relay that will not look at
    // the answer buys attribution by convention and costs a dialog before
    // anything has happened.
    const mustProve = url !== solo.address && (await relayRequiresIdentity(url));
    const identity = (await resolveIdentityWithToken(!mustProve)) ?? localIdentity(mustProve);
    if (!identity) {
      // Sharing a room needs a real identity so other people know who is
      // speaking. Offer the sign-in rather than describing it.
      const choice = await vscode.window.showErrorMessage(
        "Sign in to GitHub to join a shared room.",
        "Sign in"
      );
      if (choice === "Sign in") await signIn();
      return;
    }
    const member = identity.member;
    // Held for the session so agent connections can prove the same identity.
    // Never written to settings and never put in a Member, which is broadcast.
    githubToken = identity.githubToken;

    relay?.dispose();
    setInRoomContext(false);

    // A new room means the old agents are watching the wrong conversation.
    detachAll();
    currentRoom = room;
    me = member;
    saveState({ room, relayUrl: activeRelayUrl });
    roomsTree.setMyAgents(myAgentsForTree());

    relay = new RelayClient({
      url,
      room,
      member,
      token: roomToken(),
      githubToken,
      onEvicted: (reason) => {
        setInRoomContext(false);
        // Two machines resolving to one handle is the usual cause, and it is
        // invisible otherwise — the room just churns.
        // The reason comes first: it is the only part that varies, and anything
        // after it is what gets cut off. The advice moved onto a button.
        void vscode.window.showErrorMessage(
          `Disconnected — ${reason}`,
          "Rejoin",
          "Why?"
        ).then((choice) => {
          if (choice === "Why?") {
            void vscode.window.showInformationMessage(
              "Two machines signed in as the same person evict each other in turn. " +
                "Give one of them a different ripieno.devIdentityOverride and rejoin.",
              { modal: true }
            );
            return;
          }
          if (choice === "Rejoin") void joinRoom();
        });
      },
      onMessage: (msg) => handleServerMsg(msg),
      onStateChange: (state) => handleConnectionState(state),
    });
    relay.connect();

    await vscode.commands.executeCommand("ripieno.room.focus");
  }

  function leaveRoom(): void {
    if (!relay) {
      setInRoomContext(false);
      vscode.window.showInformationMessage("Ripieno: not connected to a room.");
      return;
    }
    detachAll();
    relay.dispose();
    relay = undefined;
    currentRoom = undefined;
    setInRoomContext(false);
    roomView.reset();
    roomsTree.setRoom(undefined, "byo");
    roomsTree.setConnected(false);
    roomsTree.setMyAgents(myAgentsForTree());
  }

  async function signIn(): Promise<void> {
    const member = await resolveIdentity(false);
    if (member) {
      vscode.window.showInformationMessage(`Ripieno: signed in as ${member.handle}.`);
    }
  }

  function handleConnectionState(state: ConnectionState): void {
    roomView.setConnection(state);
    roomsTree.setConnected(state === "online");
  }

  function handleServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case "joined":
        setInRoomContext(true);
        roomView.setJoined(msg.room, msg.you, msg.roster, msg.transcript, msg.mode, msg.actions ?? []);
        roomsTree.setRoom(msg.room, msg.mode, msg.you.handle);
        roomsTree.setRoster(msg.roster, msg.workspaceHost);
        hostingWorkspace = msg.workspaceHost === msg.you.handle;
        applyWorkspaceHost(msg.workspaceHost);
        // No second setRoster here: it takes the host as an argument, so calling
        // it without one immediately after assigns undefined and the tree shows
        // nobody hosting until the next roster broadcast.
        // A joiner should see what the room has already cost, not start at zero.
        roomsTree.setUsage(msg.usage ?? []);
        break;
      case "roster":
        roomView.setRoster(msg.roster);
        roomsTree.setRoster(msg.roster, msg.workspaceHost);
        // The relay is the authority: it releases the claim when the host
        // leaves, so believing our own flag would leave the UI lying.
        hostingWorkspace = msg.workspaceHost === me?.handle;
        applyWorkspaceHost(msg.workspaceHost);
        break;
      case "entry":
        roomView.addEntry(msg.entry);
        break;
      case "agentDelta":
        roomView.addDelta(msg.entryId, msg.text);
        break;
      case "agentDeltaCancel":
        roomView.cancelDelta(msg.entryId);
        break;
      case "toolCall":
        void runToolCall(msg);
        break;
      case "remoteToolRequest":
        void runRemoteTool(msg);
        break;
      case "workspaceInvalidated":
        // The host's disk changed by some route the room never saw — an agent's
        // own local write, or a human saving a file. Drop those paths.
        for (const changed of msg.paths) workspaceFs.invalidatePath(changed);
        workspaceTree.refresh();
        break;
      case "usage":
        roomsTree.setUsage(msg.agents);
        break;
      case "action":
        roomView.addAction(msg.entry);
        // The provenance stream doubles as cache invalidation: a write to a path
        // evicts exactly that path, so an open tab refreshes rather than lying.
        workspaceFs.noteAction(msg.entry);
        break;
      case "status":
        roomView.setStatus(msg.status, msg.waitingOn);
        break;
      case "error":
        vscode.window.showErrorMessage(`Ripieno: ${msg.message}`);
        break;
    }
  }

  /**
   * Another member's agent asking to act on *this* machine.
   *
   * Executed by the same tool executor, under this member's permissions, with
   * the same approval path — the only difference is that the approval names
   * someone else's agent, which is exactly the thing the member needs to see.
   */
  async function runRemoteTool(
    msg: Extract<ServerMsg, { t: "remoteToolRequest" }>
  ): Promise<void> {
    const result = await toolExecutor.execute(
      { t: "toolCall", callId: msg.requestId, name: msg.name, input: msg.input },
      () => undefined,
      { label: msg.requesterLabel, handle: msg.requesterHandle }
    );
    relay?.send({
      t: "remoteToolResult",
      requestId: msg.requestId,
      requesterAgentId: msg.requesterAgentId,
      content: result.content,
      isError: result.isError,
    });
  }

  async function runToolCall(msg: Extract<ServerMsg, { t: "toolCall" }>): Promise<void> {
    // Report progress as we go. The relay cannot otherwise tell a member who has
    // vanished from one reading a confirmation dialog from a slow command, and
    // has to time all three on one clock — which is how a member taking 61
    // seconds to click Run used to lose the race.
    const result = await toolExecutor.execute(msg, (state) => {
      relay?.send({ t: "toolProgress", callId: msg.callId, state });
    });
    relay?.send({
      t: "toolResult",
      callId: msg.callId,
      content: result.content,
      isError: result.isError,
    });
  }

  // Last, so everything it touches is already constructed.
  void restoreSession();
}

export function deactivate(): void {
  // Cleanup happens via context.subscriptions (relay.dispose()).
}
