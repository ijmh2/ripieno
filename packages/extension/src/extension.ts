import * as vscode from "vscode";
import { spawn } from "child_process";
import type { Member, ServerMsg } from "@mpa/protocol";
import { resolveIdentity } from "./identity";
import { RelayClient, type ConnectionState } from "@mpa/relay-client";
import { ToolExecutor, registerProposedDocuments } from "./toolExecutor";
import { RoomViewProvider } from "./roomView";
import { AgentHost, type AgentState } from "./agentHost";
import { RoomsTreeProvider, type MyAgent } from "./roomsTree";
import { PROVIDERS, isWorkspaceProvider, providerById, secretKeyFor, type ProviderPreset } from "./runners";
import { ApprovalBridge } from "./approvals";
import { WorkspaceFileSystem, WORKSPACE_SCHEME, uriFor } from "./workspaceFs";
import { WorkspaceTreeProvider, isHostDocument } from "./workspaceTree";

export function activate(context: vscode.ExtensionContext): void {
  const toolExecutor = new ToolExecutor();
  // Backs the right-hand side of the diff shown before any write is applied.
  context.subscriptions.push(registerProposedDocuments());
  let relay: RelayClient | undefined;
  let currentRoom: string | undefined;
  let hostingWorkspace = false;
  let nextFsRequest = 0;
  let watcher: vscode.FileSystemWatcher | undefined;
  /** Paths changed since the last publish, coalesced — a build touches thousands. */
  const changedPaths = new Set<string>();
  let publishTimer: NodeJS.Timeout | undefined;
  let me: Member | undefined;

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
  }
  const specs = new Map<string, AgentSpecRecord>();
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

  // Everyone starts with one agent; more can be added.
  ensureSpec("default", "agent");

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
    vscode.commands.registerCommand("mpa.joinRoom", () => joinRoom()),
    vscode.commands.registerCommand("mpa.leaveRoom", () => leaveRoom()),
    vscode.commands.registerCommand("mpa.signIn", () => signIn()),
    vscode.commands.registerCommand("mpa.addAgent", () => addAgent()),
    vscode.commands.registerCommand("mpa.hostWorkspace", () => toggleWorkspaceHost()),
    vscode.commands.registerCommand("mpa.mountWorkspace", () => mountSharedWorkspace()),
    vscode.commands.registerCommand("mpa.proposeChange", () => proposeChange()),
    vscode.commands.registerCommand("mpa.attachAgent", (node?: { id?: string }) =>
      void attachAgent(idFromNode(node))
    ),
    vscode.commands.registerCommand("mpa.detachAgent", (node?: { id?: string }) =>
      detachAgent(idFromNode(node))
    ),
    approvals,
    { dispose: () => { stopWatching(); detachAll(); relay?.dispose(); } }
  );

  /** Tree item ids are prefixed so attached and detached rows stay distinct. */
  function idFromNode(node?: { id?: string }): string | undefined {
    const raw = node?.id;
    return typeof raw === "string" ? raw.replace(/^(attached|detached):/, "") : undefined;
  }

  function ensureSpec(suffix: string, label: string): string {
    const id = `local:${suffix}`;
    if (!specs.has(id)) specs.set(id, { id, label, providerId: "claude-code" });
    return id;
  }

  function myAgentsForTree(): MyAgent[] {
    return [...specs.values()].map((spec) => ({
      id: spec.id,
      label: labelFor(spec.label),
      state: agents.get(spec.id)?.currentState ?? "detached",
      folder: spec.cwd ? spec.cwd.split("/").pop() : undefined,
      model: spec.model,
      // The first agent answers anything not addressed to someone specific.
      primary: [...specs.keys()][0] === spec.id,
      capability: isWorkspaceProvider(spec.providerId) ? "workspace" : "conversation",
      provider: spec.providerId,
    }));
  }

  function labelFor(base: string): string {
    return me ? `${me.displayName}'s ${base}` : base;
  }

  async function addAgent(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Add another agent",
      prompt: "What is this agent for? Used as its name in the room.",
      placeHolder: "e.g. reviewer",
      ignoreFocusOut: true,
    });
    if (!name) return;

    const brief = await vscode.window.showInputBox({
      title: `Brief for "${name}"`,
      prompt: "Optional standing instruction that makes this agent behave differently from your others.",
      placeHolder: "e.g. review other people's changes critically; do not write code",
      ignoreFocusOut: true,
    });

    const provider = await pickProvider(name);
    if (!provider) return;

    const id = `local:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}:${specs.size}`;
    let cwd: string | undefined;
    let model: string | undefined;
    let baseUrl: string | undefined;

    let command: string | undefined;
    let args: string[] | undefined;

    if (provider.kind === "claude-code") {
      cwd = await pickWorkingFolder(name);
      model = await pickModel(name);
    } else if (provider.kind === "cli") {
      cwd = await pickWorkingFolder(name);
      command = provider.command;
      if (!command) {
        command = await vscode.window.showInputBox({
          title: `Command for "${name}"`,
          prompt: "Executable to run. It must be on your PATH.",
          placeHolder: "e.g. codex",
          ignoreFocusOut: true,
        });
        if (!command) return;
      }
      // Editable even for presets: these CLIs change their flags, and a wrong
      // one wedges the agent on a prompt nobody can answer.
      const rawArgs = await vscode.window.showInputBox({
        title: `Arguments for "${name}"`,
        prompt:
          "Space-separated. {prompt} is replaced with the conversation; omit it to send the prompt on stdin.",
        value: (provider.args ?? ["{prompt}"]).join(" "),
        ignoreFocusOut: true,
      });
      if (rawArgs === undefined) return;
      args = rawArgs.split(/\s+/).filter(Boolean);

      if (!(await commandExists(command))) {
        const go = await vscode.window.showWarningMessage(
          `"${command}" is not on your PATH. The agent will fail to start until it is installed and signed in.`,
          "Add anyway",
          "Cancel"
        );
        if (go !== "Add anyway") return;
      }
    } else {
      baseUrl = provider.baseUrl;
      if (!baseUrl) {
        baseUrl = await vscode.window.showInputBox({
          title: `Endpoint for "${name}"`,
          prompt: "Base URL of an OpenAI-compatible API. /chat/completions is appended.",
          placeHolder: "https://api.example.com/v1",
          ignoreFocusOut: true,
        });
        if (!baseUrl) return;
      }
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
      brief: brief || undefined,
      cwd,
      model,
      providerId: provider.id,
      baseUrl,
      command,
      args,
    });
    roomsTree.setMyAgents(myAgentsForTree());
    // Attaching straight away is almost always what was meant.
    if (currentRoom) void attachAgent(id);
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
    void vscode.commands.executeCommand("setContext", "mpa.hasSharedWorkspace", Boolean(someoneElse));
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
      vscode.window.showInformationMessage("Multiplayer Agent: join a room first.");
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
      vscode.window.showInformationMessage("Multiplayer Agent: nobody is hosting a shared workspace.");
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
      vscode.window.showInformationMessage("Multiplayer Agent: open a file to propose a change.");
      return;
    }
    const host = workspaceTree.hostHandle;
    if (!host) {
      vscode.window.showInformationMessage("Multiplayer Agent: nobody is hosting a shared workspace.");
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
        ? `Multiplayer Agent: ${result.content}`
        : `Sent to @${host} — they decide whether to apply it.`
    );
  }

  /** Is this executable actually available? A missing CLI fails silently otherwise. */
  async function commandExists(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      const probe = spawn("which", [command], { stdio: "ignore" });
      probe.on("close", (code) => resolve(code === 0));
      probe.on("error", () => resolve(false));
    });
  }

  /**
   * Which model provider runs this agent.
   *
   * The room is provider-agnostic, so a Grok or Kimi agent participates on the
   * same terms as a Claude one — except for file access, which only a local
   * Claude Code agent has. The picker says so rather than leaving it implied.
   */
  async function pickProvider(name: string): Promise<ProviderPreset | undefined> {
    // Wrapped rather than spread: a preset's `kind` would collide with
    // QuickPickItem.kind and turn every entry into a separator.
    const picked = await vscode.window.showQuickPick(
      PROVIDERS.map((preset) => ({
        label: preset.label,
        description: preset.hint,
        preset,
      })),
      { title: `What should run "${name}"?`, ignoreFocusOut: true }
    );
    return picked?.preset;
  }

  /** Models an agent can run on. Aliases track the latest of each family. */
  const MODELS = [
    { label: "$(sparkle) Opus", description: "most capable — deep reasoning, harder problems", value: "opus" },
    { label: "$(zap) Sonnet", description: "faster and cheaper — good for routine work", value: "sonnet" },
    { label: "$(dashboard) Haiku", description: "fastest — quick lookups and simple edits", value: "haiku" },
    { label: "$(gear) Default", description: "whatever your Claude Code is configured to use", value: "" },
  ];

  async function pickModel(name: string): Promise<string | undefined> {
    const choice = await vscode.window.showQuickPick(MODELS, {
      title: `Which model should "${name}" run on?`,
      ignoreFocusOut: true,
    });
    return choice?.value || undefined;
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
            "  /model <opus|sonnet|haiku|default> [agent]  — set the model for your agents",
            "  /agents                                     — list your agents",
            "  /detach [agent]                             — stop an agent",
            "  /help                                       — this list",
          ].join("\n")
        );
        return true;

      case "agents": {
        const rows = [...specs.values()].map((spec) => {
          const state = agents.get(spec.id)?.currentState ?? "detached";
          const where = spec.cwd ? ` · ${spec.cwd}` : "";
          return `  ${labelFor(spec.label)} — ${state} · ${spec.model ?? "default model"}${where}`;
        });
        note(rows.length > 0 ? `Your agents:\n${rows.join("\n")}` : "You have no agents.");
        return true;
      }

      case "model": {
        const [wanted, target] = argument.split(/\s+/);
        if (!wanted) {
          note("Usage: /model <opus|sonnet|haiku|default> [agent name]");
          return true;
        }
        const value = wanted.toLowerCase() === "default" ? undefined : wanted.toLowerCase();
        const matched = [...specs.values()].filter(
          (spec) => !target || spec.label.toLowerCase().includes(target.toLowerCase())
        );
        if (matched.length === 0) {
          note(`No agent matching "${target}".`);
          return true;
        }
        for (const spec of matched) {
          spec.model = value;
          // Restart so the change takes effect now rather than next attach; the
          // session is per-process, so there is no way to switch mid-session.
          if (agents.has(spec.id)) {
            detachAgent(spec.id);
            void attachAgent(spec.id);
          }
        }
        note(
          `${matched.map((s) => labelFor(s.label)).join(", ")} now on ${value ?? "the default model"}` +
            (matched.some((s) => agents.has(s.id)) ? " (restarted — its session starts fresh)." : ".")
        );
        return true;
      }

      case "detach": {
        const matched = [...specs.values()].filter(
          (spec) => !argument || spec.label.toLowerCase().includes(argument.toLowerCase())
        );
        for (const spec of matched) detachAgent(spec.id);
        note(`Detached ${matched.map((s) => labelFor(s.label)).join(", ") || "nothing"}.`);
        return true;
      }

      default:
        note(`Unknown command "/${command}". Try /help.`);
        return true;
    }
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
  async function pickWorkingFolder(name: string): Promise<string | undefined> {
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
    if (!choice || choice.label.startsWith("$(folder) ")) return undefined;

    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: `Use as ${name}'s project`,
      title: `Working folder for "${name}"`,
    });
    return picked?.[0]?.fsPath;
  }

  /**
   * Attaching starts a real process, which is what makes dragging an agent into
   * a room meaningful rather than a picture of state you created by hand.
   */
  async function attachAgent(id?: string): Promise<void> {
    const spec = id ? specs.get(id) : [...specs.values()][0];
    if (!spec) return;
    if (!currentRoom || !me) {
      vscode.window.showInformationMessage("Multiplayer Agent: join a room first.");
      return;
    }
    if (agents.has(spec.id)) return;

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
      id: spec.id,
      label: labelFor(spec.label),
      brief: spec.brief,
      cwd: spec.cwd,
      model: spec.model,
      providerId: spec.providerId,
      baseUrl: spec.baseUrl,
      command: spec.command,
      args: spec.args,
      apiKey,
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

  function roomToken(): string | undefined {
    const token = vscode.workspace.getConfiguration("mpa").get<string>("roomToken", "").trim();
    return token || undefined;
  }

  function relayUrl(): string {
    return vscode.workspace
      .getConfiguration("mpa")
      .get<string>("relayUrl", "ws://localhost:8787");
  }

  async function joinRoom(): Promise<void> {
    const room = await vscode.window.showInputBox({
      title: "Join Multiplayer Agent Room",
      prompt: "Room code",
      placeHolder: "e.g. tgtbt-standup",
      ignoreFocusOut: true,
    });
    if (!room) {
      return;
    }

    const member = await resolveIdentity(false);
    if (!member) {
      vscode.window.showErrorMessage(
        "Multiplayer Agent: sign in to GitHub is required to join a room."
      );
      return;
    }

    relay?.dispose();

    // A new room means the old agents are watching the wrong conversation.
    detachAll();
    currentRoom = room;
    me = member;
    roomsTree.setMyAgents(myAgentsForTree());

    relay = new RelayClient({
      url: relayUrl(),
      room,
      member,
      token: roomToken(),
      onEvicted: (reason) => {
        // Two machines resolving to one handle is the usual cause, and it is
        // invisible otherwise — the room just churns.
        void vscode.window.showErrorMessage(
          `Multiplayer Agent: disconnected — ${reason}. ` +
            "If another machine is signed in as the same person, give one of them a different " +
            "mpa.devIdentityOverride and rejoin.",
          "Rejoin"
        ).then((choice) => {
          if (choice === "Rejoin") void joinRoom();
        });
      },
      onMessage: (msg) => handleServerMsg(msg),
      onStateChange: (state) => handleConnectionState(state),
    });
    relay.connect();

    await vscode.commands.executeCommand("mpa.room.focus");
  }

  function leaveRoom(): void {
    if (!relay) {
      vscode.window.showInformationMessage("Multiplayer Agent: not connected to a room.");
      return;
    }
    detachAll();
    relay.dispose();
    relay = undefined;
    currentRoom = undefined;
    roomView.reset();
    roomsTree.setRoom(undefined, "byo");
    roomsTree.setConnected(false);
    roomsTree.setMyAgents(myAgentsForTree());
  }

  async function signIn(): Promise<void> {
    const member = await resolveIdentity(false);
    if (member) {
      vscode.window.showInformationMessage(`Multiplayer Agent: signed in as ${member.handle}.`);
    }
  }

  function handleConnectionState(state: ConnectionState): void {
    roomView.setConnection(state);
    roomsTree.setConnected(state === "online");
  }

  function handleServerMsg(msg: ServerMsg): void {
    switch (msg.t) {
      case "joined":
        roomView.setJoined(msg.room, msg.you, msg.roster, msg.transcript, msg.mode, msg.actions ?? []);
        roomsTree.setRoom(msg.room, msg.mode, msg.you.handle);
        roomsTree.setRoster(msg.roster, msg.workspaceHost);
        hostingWorkspace = msg.workspaceHost === msg.you.handle;
        applyWorkspaceHost(msg.workspaceHost);
        roomsTree.setRoster(msg.roster);
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
        vscode.window.showErrorMessage(`Multiplayer Agent: ${msg.message}`);
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
}

export function deactivate(): void {
  // Cleanup happens via context.subscriptions (relay.dispose()).
}
