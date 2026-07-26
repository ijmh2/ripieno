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
import { spawn, type ChildProcess } from "child_process";
import type { Member, TranscriptEntry } from "@mpa/protocol";
import { RelayClient } from "./relayClient";
import type { ApprovalBridge } from "./approvals";

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
}

export interface AgentHostOptions extends AgentSpec {
  url: string;
  room: string;
  member: Member;
  approvals: ApprovalBridge;
  token?: string;
  permissionServerPath: string;
  onStateChange: (id: string, state: AgentState) => void;
  /** Other agents this member runs, so this one can tell when it was not the one asked. */
  siblingLabels?: string[];
}

export class AgentHost implements vscode.Disposable {
  private relay: RelayClient | undefined;
  private child: ChildProcess | undefined;
  private readonly output: vscode.OutputChannel;
  private readonly transcript: TranscriptEntry[] = [];

  /** Claude Code session this agent owns, so its turns share context. */
  private sessionId: string | undefined;
  /** How far through the transcript that session has already been told about. */
  private fed = 0;
  private busy = false;
  private pending: NodeJS.Timeout | undefined;
  private state: AgentState = "detached";

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
    // A fresh attach is a fresh conversation; resuming a stale session would
    // carry over a chat about a room this agent is no longer in.
    this.sessionId = undefined;

    this.relay = new RelayClient({
      url: this.opts.url,
      room: this.opts.room,
      member: this.opts.member,
      role: "agent",
      agentId: this.opts.id,
      agentLabel: this.opts.label,
      token: this.opts.token,
      onStateChange: (s) => this.setState(s === "online" ? "idle" : "attaching"),
      onMessage: (msg) => {
        if (msg.t === "joined") {
          this.transcript.push(...msg.transcript);
          // Everything before we attached is context, not a question to answer.
          this.fed = this.transcript.length;
        } else if (msg.t === "entry") {
          this.transcript.push(msg.entry);
          this.consider(msg.entry);
        }
      },
    });
    this.relay.connect();
    this.log(`attached to "${this.opts.room}" as ${this.opts.label}`);
  }

  dispose(): void {
    this.clearPending();
    this.child?.kill();
    this.child = undefined;
    this.relay?.dispose();
    this.relay = undefined;
    this.busy = false;
    this.setState("detached");
    this.log("detached");
    this.output.dispose();
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

  /**
   * Answer when named, or when primary and nobody else was named.
   *
   * Deterministic rather than conventional: an addressed agent always replies,
   * an unaddressed message gets exactly one reply per member, and a member can
   * consult a specific agent without silencing the rest of the room.
   */
  private shouldAnswer(entry: TranscriptEntry): boolean {
    if (this.addresses(entry.text, this.opts.label)) return true;
    // Somebody else was named — stay out of it.
    if (this.namesAnyAgent(entry.text)) return false;
    return this.opts.primary !== false;
  }

  /** Named by its own label, or by the distinctive part of it ("reviewer"). */
  private addresses(text: string, label: string): boolean {
    const haystack = text.toLowerCase();
    if (haystack.includes(label.toLowerCase())) return true;
    const distinctive = label.split(/[\s']+/).pop();
    if (!distinctive || distinctive.length < 3) return false;
    return new RegExp(`(^|[^a-z])@?${escapeRegExp(distinctive.toLowerCase())}([^a-z]|$)`).test(haystack);
  }

  private namesAnyAgent(text: string): boolean {
    return this.opts.siblingLabels?.some((label) => this.addresses(text, label)) === true;
  }

  private async respond(): Promise<void> {
    if (this.busy || !this.relay) return;

    // With a live session only the unseen messages need sending; the session
    // remembers the rest, including whatever it read last turn.
    const unseen = this.transcript.slice(this.fed).filter((e) => e.kind !== "system");
    if (unseen.length === 0) return;
    this.busy = true;
    this.fed = this.transcript.length;
    this.setState("thinking");

    try {
      const args = await this.buildArgs(unseen);
      const cwd = this.workingDirectory();
      this.log(this.sessionId ? "thinking (resumed session)" : "thinking (new session)");
      this.run(args, cwd);
    } catch (err) {
      this.busy = false;
      this.setState("idle");
      this.log(`could not start a turn: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async buildArgs(unseen: TranscriptEntry[]): Promise<string[]> {
    const body = unseen.map((e) => `${e.authorName} (@${e.authorHandle}): ${e.text}`).join("\n\n");
    const prompt = this.sessionId
      ? body
      : `${this.systemPreamble()}\n\n--- the room so far ---\n${this.recent()}`;

    const bridge = await this.opts.approvals.start();
    // Route permission requests to the member instead of leaving them
    // unanswerable. A headless run cannot prompt, so without this anything
    // needing approval strands rather than being decided.
    const mcpConfig = {
      mcpServers: {
        approvals: {
          // `process.execPath` in an extension host is the *Electron* binary,
          // not node. Launched plainly it opens an editor window instead of
          // running our script — the server never starts, the permission tool
          // Claude Code was told to use cannot be found, and the agent hangs
          // forever on a mechanism that does not exist. ELECTRON_RUN_AS_NODE
          // makes the same binary behave as node, which avoids depending on
          // node being on PATH at all.
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
    };

    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      // Only our approvals server: .mcp.json would otherwise boot the room MCP
      // server here too, joining as a second agent under the same handle.
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--permission-prompt-tool",
      "mcp__approvals__approve",
      "--permission-mode",
      permissionMode(),
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    // Resume by explicit id rather than --continue, which would latch onto
    // whatever conversation last ran in this folder — possibly the human's own.
    if (this.sessionId) args.push("--resume", this.sessionId);
    return args;
  }

  private run(args: string[], cwd: string | undefined): void {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => this.log(d.toString().trimEnd()));

    child.on("error", (err) => {
      this.busy = false;
      this.child = undefined;
      this.setState("idle");
      this.log(`could not start claude: ${err.message}`);
      void vscode.window.showErrorMessage(
        "Multiplayer Agent: could not start Claude Code. Is the `claude` CLI on your PATH?"
      );
    });

    child.on("close", (code) => {
      this.busy = false;
      this.child = undefined;
      this.setState("idle");

      let text = out.trim();
      try {
        const parsed = JSON.parse(text) as { session_id?: string; result?: string };
        if (parsed.session_id) this.sessionId = parsed.session_id;
        text = String(parsed.result ?? "").trim();
      } catch {
        // Not JSON — fall back to raw output rather than losing the reply.
      }
      if (code !== 0 || !text) {
        this.log(`no reply (exit ${code})`);
        return;
      }
      this.relay?.send({ t: "say", text });
      this.log(`posted ${text.length} chars`);

      // Anything said while we were thinking still needs an answer.
      if (this.transcript.length > this.fed) {
        this.consider(this.transcript[this.transcript.length - 1]);
      }
    });
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
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function permissionMode(): string {
  const mode = vscode.workspace
    .getConfiguration("mpa")
    .get<string>("agentPermissions", "ask");
  return mode === "bypassPermissions" ? "bypassPermissions" : "acceptEdits";
}
