// Runs a member's own agents inside a room (BYO mode).
//
// MCP is pull-based: an agent attached over MCP only acts when its human
// prompts it, so it never notices that somebody spoke. Each AgentHost closes
// that gap for one agent — it holds the room connection itself, watches for
// messages, runs a Claude Code turn, and posts the answer back. Because the
// host owns the connection, the agent stays resident in the roster instead of
// joining and leaving around every turn.
//
// A member may run several of these at once (a coder and a reviewer, say). Each
// has its own id, its own label in the transcript, and its own Claude Code
// session, so they genuinely reason separately rather than sharing a context.

import * as vscode from "vscode";
import { randomBytes } from "crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Member, RosterEntry, TranscriptEntry } from "@mpa/protocol";
import {
  shouldAnswer,
  nextUnanswered,
  type AgentIdentity,
  type SelfIdentity,
} from "./addressing";
import { RelayClient } from "@mpa/relay-client";
import type { ApprovalBridge } from "./approvals";
import {
  ClaudeCodeRunner,
  CliRunner,
  OpenAiCompatRunner,
  providerById,
  isWorkspaceProvider,
  type ModelRunner,
  type RunnerCapability,
} from "./runners";

/** Let the room settle before answering, so a burst produces one considered reply. */
const DEBOUNCE_MS = 1500;
/** How much of the transcript a brand-new session is given as context. */
const HISTORY = 25;

export type AgentState = "detached" | "attaching" | "idle" | "thinking";

export interface AgentSpec {
  /** Unique within the room; several agents may share an owner. */
  id: string;
  /** Transcript label, e.g. "Mira's reviewer". */
  label: string;
  /** Extra standing instruction, so two of one member's agents can differ. */
  brief?: string;
  /**
   * Directory this agent works in. Defaults to the editor's workspace, but an
   * agent can be pointed at any project — including a new, empty one — so a
   * room can span several codebases rather than assuming everyone shares one.
   */
  cwd?: string;
  /**
   * Whether this agent answers messages that name nobody in particular.
   *
   * Exactly one of a member's agents is primary. Without this, every agent a
   * member runs replies to every message — a pile-on that gets worse with each
   * agent added — and the only thing preventing it was a line of prompt asking
   * them to be polite. Turn-taking is not something to leave to good manners.
   */
  primary?: boolean;
  /**
   * Model alias or full id for this agent. Per-agent rather than per-room, so a
   * member can run a careful reviewer and a fast coder side by side and have
   * them genuinely differ rather than being one model wearing two labels.
   */
  model?: string;
  /** Which provider runs it: claude-code, grok, kimi, ollama, custom… */
  providerId?: string;
  /** OpenAI-compatible base URL, for every provider except claude-code. */
  baseUrl?: string;
  /** Resolved from SecretStorage at attach time; never stored in settings. */
  apiKey?: string;
  /** cli providers: the executable and its arguments. */
  command?: string;
  args?: string[];
}

export interface AgentHostOptions extends AgentSpec {
  url: string;
  room: string;
  member: Member;
  approvals: ApprovalBridge;
  token?: string;
  /**
   * Proves the owner's handle.
   *
   * An agent connection claims its owner's identity, so it has to prove it for
   * the same reason they do — otherwise verification would be one `role: "agent"`
   * away from being bypassed entirely.
   */
  githubToken?: string;
  permissionServerPath: string;
  workspaceServerPath: string;
  onStateChange: (id: string, state: AgentState) => void;
  /** Other agents this member runs. Superseded at runtime by the live roster. */
  siblingLabels?: string[];
}

export class AgentHost implements vscode.Disposable {
  private relay: RelayClient | undefined;
  private runner: ModelRunner | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly transcript: TranscriptEntry[] = [];

  /** How far through the transcript that session has already been told about. */
  private fed = 0;
  private busy = false;
  private pending: NodeJS.Timeout | undefined;
  /**
   * Remote tool calls awaiting a reply from the member executing them.
   *
   * The relay only routes remote tools for *agent* connections, so anything in
   * the extension that wants to reach another member's workspace — the
   * filesystem view, "propose change" — borrows this agent's identity. That is
   * also the right attribution: the action log records the agent, and the agent
   * belongs to the person who asked.
   */
  private readonly remoteCalls = new Map<
    string,
    { resolve: (r: { content: string; isError: boolean }) => void; timer: NodeJS.Timeout }
  >();
  /**
   * Loopback bridge serving this agent's shared-workspace tools.
   *
   * The agent's MCP server cannot join the room itself without opening a second
   * connection under the same identity, so it asks us instead and we use the
   * connection we already hold. Same shape as the approval bridge, and for the
   * same reason.
   */
  private workspaceBridge: WebSocketServer | undefined;
  private readonly workspaceToken = randomBytes(24).toString("hex");
  private workspaceUrl: string | undefined;
  private state: AgentState = "detached";
  /**
   * Every other agent in the room, from the live roster.
   *
   * Knowing only this member's siblings was not enough: when somebody named
   * *another member's* agent, this one did not recognise it as a name, ran a
   * full turn, and then declined — having already spent the tokens. The roster
   * carries all of them, so the gate can close before the model runs.
   */
  private others: AgentIdentity[] = [];

  constructor(private readonly opts: AgentHostOptions) {
    this.output = vscode.window.createOutputChannel(`Multiplayer Agent — ${opts.label}`);
  }

  get id(): string {
    return this.opts.id;
  }

  get label(): string {
    return this.opts.label;
  }

  get currentState(): AgentState {
    return this.state;
  }

  attach(): void {
    if (this.relay) return;
    this.setState("attaching");
    this.transcript.length = 0;
    this.fed = 0;
    // A fresh attach is a fresh conversation: drop the runner so its session
    // (or message history) starts clean rather than carrying over a chat about
    // a room this agent is no longer in.
    this.runner?.cancel();
    this.runner = undefined;

    this.relay = new RelayClient({
      url: this.opts.url,
      room: this.opts.room,
      member: this.opts.member,
      role: "agent",
      agentId: this.opts.id,
      agentLabel: this.opts.label,
      token: this.opts.token,
      githubToken: this.opts.githubToken,
      onStateChange: (s) => this.setState(s === "online" ? "idle" : "attaching"),
      onMessage: (msg) => {
        if (msg.t === "joined") {
          this.noteRoster(msg.roster);
          this.transcript.push(...msg.transcript);
          // Everything before we attached is context, not a question to answer.
          this.fed = this.transcript.length;
        } else if (msg.t === "entry") {
          this.transcript.push(msg.entry);
          this.consider(msg.entry);
        } else if (msg.t === "roster") {
          this.noteRoster(msg.roster);
        } else if (msg.t === "remoteToolReply") {
          const waiting = this.remoteCalls.get(msg.requestId);
          if (waiting) {
            clearTimeout(waiting.timer);
            this.remoteCalls.delete(msg.requestId);
            waiting.resolve({ content: msg.content, isError: msg.isError === true });
          }
        }
      },
    });
    this.relay.connect();
    this.log(`attached to "${this.opts.room}" as ${this.opts.label}`);
  }

  dispose(): void {
    this.clearPending();
    // Settle, do not merely forget. These promises back an open editor tab and
    // "propose change"; abandoning them left the tab spinning forever with no
    // error, and the timer that would eventually have failed them was cleared
    // on the way out.
    for (const { timer, resolve } of this.remoteCalls.values()) {
      clearTimeout(timer);
      resolve({ content: "This agent was detached before the workspace answered.", isError: true });
    }
    this.remoteCalls.clear();
    for (const client of this.workspaceBridge?.clients ?? []) client.terminate();
    this.workspaceBridge?.close();
    this.workspaceBridge = undefined;
    this.workspaceUrl = undefined;
    this.runner?.cancel();
    this.runner = undefined;
    this.relay?.dispose();
    this.relay = undefined;
    this.busy = false;
    this.setState("detached");
    this.log("detached");
    this.output.dispose();
  }

  /** Start the loopback bridge once; the port is chosen by the OS. */
  private startWorkspaceBridge(): Promise<string> {
    if (this.workspaceUrl) return Promise.resolve(this.workspaceUrl);
    return new Promise((resolve, reject) => {
      // Loopback only, plus a per-agent secret: this socket can act on another
      // member's machine, so no other local process should be able to drive it.
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 }, () => {
        const address = wss.address();
        if (typeof address === "string" || address === null) {
          reject(new Error("workspace bridge could not bind"));
          return;
        }
        this.workspaceUrl = `ws://127.0.0.1:${address.port}`;
        resolve(this.workspaceUrl);
      });
      this.workspaceBridge = wss;

      wss.on("error", reject);
      wss.on("connection", (socket: WebSocket, req) => {
        if (req.headers["x-mpa-token"] !== this.workspaceToken) {
          socket.close(4001, "bad token");
          return;
        }
        socket.on("message", (raw) => void this.serveWorkspaceCall(socket, raw));
      });
    });
  }

  private async serveWorkspaceCall(socket: WebSocket, raw: unknown): Promise<void> {
    let request: { id: string; name: string; input: Record<string, unknown> };
    try {
      request = JSON.parse(String(raw));
    } catch {
      return;
    }
    const result = await this.remoteTool(`ws_${request.id}`, request.name, request.input ?? {});
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ id: request.id, ...result }));
    }
  }

  /**
   * Act on another member's workspace through this agent's connection.
   *
   * Generous timeout: the other end may be showing a human a diff to approve,
   * and cutting that short would look like a failure rather than a decision.
   */
  remoteTool(
    requestId: string,
    name: string,
    input: Record<string, unknown>,
    timeoutMs = 300_000
  ): Promise<{ content: string; isError: boolean }> {
    if (!this.relay) {
      return Promise.resolve({ content: "This agent is not attached to a room.", isError: true });
    }
    this.relay.send({ t: "remoteTool", requestId, targetHandle: "room", name, input });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.remoteCalls.delete(requestId);
        resolve({
          content: `No answer from the workspace host within ${timeoutMs / 1000}s.`,
          isError: true,
        });
      }, timeoutMs);
      this.remoteCalls.set(requestId, { resolve, timer });
    });
  }

  /**
   * React to any human message, including our owner's — an agent that ignores
   * the person it belongs to is useless. Agent messages are deliberately not
   * triggers: that is what stops several agents in a room answering each other
   * forever, which matters more now that one member can run two.
   */
  private consider(entry: TranscriptEntry): void {
    if (entry.kind !== "human") return;
    if (!this.shouldAnswer(entry)) return;
    this.clearPending();
    this.pending = setTimeout(() => void this.respond(), DEBOUNCE_MS);
  }

  /** Track every other agent in the room, so addressing can be decided locally. */
  private noteRoster(roster: RosterEntry[]): void {
    this.others = roster
      .flatMap((member) =>
        member.agents.map((agent) => ({ label: agent.label, handle: member.handle }))
      )
      .filter((agent) => agent.label !== this.opts.label);
  }

  private shouldAnswer(entry: TranscriptEntry): boolean {
    return shouldAnswer(entry.text, this.me(), this.siblings());
  }

  /** Tell the room what that turn cost, if the provider said. */
  private reportUsage(): void {
    const usage = this.runner?.lastUsage?.();
    if (!usage) return;
    this.relay?.send({
      t: "agentUsage",
      provider: this.opts.providerId ?? "claude-code",
      usage,
    });
  }

  private me(): SelfIdentity {
    return {
      label: this.opts.label,
      handle: this.opts.member.handle,
      primary: this.opts.primary !== false,
    };
  }

  /**
   * Fall back to configured siblings until the first roster arrives, so a
   * message in the first moments after attaching is still routed sanely.
   */
  private siblings(): AgentIdentity[] {
    return this.others.length > 0
      ? this.others
      : (this.opts.siblingLabels ?? []).map((label) => ({
          label,
          handle: this.opts.member.handle,
        }));
  }

  private async respond(): Promise<void> {
    if (this.busy || !this.relay) return;

    // With a live session only the unseen messages need sending; the runner
    // remembers the rest, however it happens to do that.
    const unseen = this.transcript.slice(this.fed).filter((e) => e.kind !== "system");
    if (unseen.length === 0) return;
    this.busy = true;
    this.fed = this.transcript.length;
    this.setState("thinking");

    try {
      const runner = await this.ensureRunner();
      const text = await runner.run(
        {
          system: this.systemPreamble(),
          unseen: unseen.map((e) => `${e.authorName} (@${e.authorHandle}): ${e.text}`).join("\n\n"),
          recent: this.recent(),
          cwd: this.workingDirectory(),
        },
        (line) => this.log(line)
      );

      // Report before posting: a turn that produced no reply still cost money,
      // and reporting only successful answers would understate every agent that
      // is having a bad day.
      this.reportUsage();

      if (text) {
        this.relay?.send({ t: "say", text });
        this.log(`posted ${text.length} chars`);
      } else {
        this.log("no reply produced");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log(`turn failed: ${detail}`);
      // Say so in the room rather than going quiet: a silent agent looks like a
      // thinking one, and nobody can tell a broken key from a slow model.
      this.relay?.send({ t: "say", text: `(could not answer — ${detail})` });
    } finally {
      this.busy = false;
      this.setState("idle");
      // Anything said while we were thinking still needs an answer.
      //
      // Re-arming on the *last* entry silently dropped it: consider() ignores
      // anything that is not a human message, so a join or another agent's
      // reply arriving after the question meant nobody ever answered — and in a
      // room with several agents that is the common case, not the edge one.
      const waiting = nextUnanswered(this.transcript.slice(this.fed), this.me(), this.siblings());
      if (waiting) this.consider(waiting);
    }
  }

  /**
   * Build the runner for this agent's provider, once, on first use.
   *
   * Claude Code needs the approval bridge wired in; a hosted chat API needs a
   * key and a URL. Both end up behind the same interface so the rest of this
   * class does not care which is which.
   */
  private async ensureRunner(): Promise<ModelRunner> {
    if (this.runner) return this.runner;

    if (isWorkspaceProvider(this.opts.providerId ?? "claude-code")) {
      const bridge = await this.opts.approvals.start();
    const workspaceUrl = await this.startWorkspaceBridge();
      // Route permission requests to the member instead of leaving them
      // unanswerable. A headless run cannot prompt, so without this anything
      // needing approval strands rather than being decided.
      const mcpConfig = JSON.stringify({
        mcpServers: {
          // Shared-workspace tools, served through the room connection this
          // host already holds — so the agent gets them without joining twice.
          workspace: {
            command: process.execPath,
            args: [this.opts.workspaceServerPath],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              MPA_WORKSPACE_URL: workspaceUrl,
              MPA_WORKSPACE_TOKEN: this.workspaceToken,
            },
          },
          approvals: {
            // `process.execPath` in an extension host is the *Electron* binary,
            // not node. ELECTRON_RUN_AS_NODE makes the same binary behave as
            // node, which avoids depending on node being on PATH.
            command: process.execPath,
            args: [this.opts.permissionServerPath],
            env: {
              ELECTRON_RUN_AS_NODE: "1",
              MPA_APPROVAL_URL: bridge.url,
              MPA_APPROVAL_TOKEN: bridge.token,
              MPA_AGENT_ID: this.opts.id,
              MPA_AGENT_LABEL: this.opts.label,
            },
          },
        },
      });
      this.runner = new ClaudeCodeRunner({
        model: this.opts.model,
        permissionMode: permissionMode(),
        mcpConfig,
        permissionPromptTool: "mcp__approvals__approve",
      });
      return this.runner;
    }

    if (providerById(this.opts.providerId ?? "")?.kind === "cli") {
      if (!this.opts.command) {
        throw new Error(`${this.opts.label} has no command configured — re-add the agent.`);
      }
      this.runner = new CliRunner({
        command: this.opts.command,
        args: this.opts.args ?? ["{prompt}"],
        label: this.opts.label,
        timeoutMs: 300_000,
      });
      return this.runner;
    }

    if (!this.opts.baseUrl || !this.opts.apiKey) {
      throw new Error(
        `${this.opts.label} has no endpoint or API key configured — re-add the agent to set them.`
      );
    }
    this.runner = new OpenAiCompatRunner({
      baseUrl: this.opts.baseUrl,
      model: this.opts.model ?? "",
      apiKey: this.opts.apiKey,
      label: this.opts.label,
    });
    return this.runner;
  }

  /** What this agent can actually do, for the room to display honestly. */
  get capability(): RunnerCapability {
    return isWorkspaceProvider(this.opts.providerId ?? "claude-code")
      ? "workspace"
      : "conversation";
  }

  /** Where this agent works. Its own folder if given, else the editor's. */
  private workingDirectory(): string | undefined {
    return this.opts.cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private systemPreamble(): string {
    const cwd = this.workingDirectory() ?? "this workspace";
    const lines = [
      `You are "${this.opts.label}", participating in a shared room alongside other people and their`,
      `agents. Messages arrive labelled with their author. Attribute anything you assert to whoever said`,
      `it, and never merge different people's statements into one anonymous view.`,
      ``,
      `Other agents may be in this room, including others belonging to your own owner. Do not answer them —`,
      `only the people. Whether you are the one to reply is decided before you are asked, so if you are`,
      `reading this, the message is yours to answer.`,
      ``,
      `You have file and shell access to ${cwd}, and that directory is yours to work in — create files,`,
      `run commands, initialise git, scaffold a project from nothing. Other members may be working in`,
      `different directories entirely, so say which project you mean when it could be ambiguous.`,
      ``,
      `Behave exactly as you normally would: read code before`,
      `answering about it, run commands when that is the way to find out, and say plainly when a claim in`,
      `the room is unsupported rather than repeating it. Actions needing permission will prompt your owner,`,
      `so a refusal is a real decision — do not simply retry it.`,
      ``,
      `Your reply is posted verbatim into the room, so write the message itself — no preamble, no sign-off.`,
      `Length should fit the question. Several people are reading, so do not pad.`,
    ];
    if (this.opts.brief) {
      lines.push("", `Your particular role in this room: ${this.opts.brief}`);
    }
    return lines.join("\n");
  }

  private recent(): string {
    return this.transcript
      .slice(-HISTORY)
      .filter((e) => e.kind !== "system")
      .map((e) => `${e.authorName} (@${e.authorHandle}): ${e.text}`)
      .join("\n\n");
  }

  private clearPending(): void {
    if (this.pending) {
      clearTimeout(this.pending);
      this.pending = undefined;
    }
  }

  private setState(state: AgentState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange(this.opts.id, state);
  }

  private log(line: string): void {
    this.output.appendLine(line);
  }
}

/**
 * What an agent may do without being asked.
 *
 * With the approval bridge in place the honest default is "ask" — the member
 * gets a modal and decides, exactly as they would in their own editor. The
 * bypass option exists for a room you are alone in, where the prompts are noise.
 */
function permissionMode(): string {
  const mode = vscode.workspace
    .getConfiguration("mpa")
    .get<string>("agentPermissions", "ask");
  return mode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";
}
