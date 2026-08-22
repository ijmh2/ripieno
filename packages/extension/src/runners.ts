// What actually produces an agent's reply.
//
// The room is provider-agnostic by construction: an agent is a WebSocket
// connection that reads an attributed transcript and posts to it. Which model
// writes the words is an implementation detail, so it lives behind this
// interface rather than being baked into AgentHost.
//
// The two implementations differ in a way the room must not hide. Claude Code
// runs locally with real file and shell access, so it can act on a member's
// workspace. A hosted chat API can only talk. Presenting both as "an agent"
// without distinction would let somebody ask Grok to fix a file and receive a
// confident answer while nothing happens — so capability is part of the
// interface and gets surfaced in the UI.

import { spawn, type ChildProcess } from "child_process";
import type { TurnUsage } from "@ripieno/protocol";
import { validateProviderBaseUrl } from "./relaySecurity";

/** What an agent can actually do, which the room shows rather than implies. */
export type RunnerCapability = "workspace" | "conversation";

export interface RunContext {
  /** Standing instructions: who this agent is and how the room works. */
  system: string;
  /**
   * Who is in the room right now, and which of them are agents.
   *
   * Separate from `system` because the standing instructions are sent once per
   * session and this is true only at the moment it is sent — somebody joining
   * afterwards would never reach the model. Every runner must include it on
   * every turn, whichever prompt path it takes; an agent that cannot check the
   * roster guesses from display names, and an agent that guesses refuses people.
   */
  roster: string;
  /** Messages it has not seen yet, already attributed. */
  unseen: string;
  /** The whole recent room, sent when there is no prior session to build on. */
  recent: string;
  /** Where a workspace-capable runner should work. */
  cwd?: string;
}

export interface ModelRunner {
  readonly capability: RunnerCapability;
  /** A short name for the model, shown beside the agent. */
  readonly description: string;
  run(ctx: RunContext, log: (line: string) => void): Promise<string>;
  cancel(): void;
  /**
   * What the last turn cost, if this provider says.
   *
   * Undefined means "it does not report", which is deliberately different from
   * a zero — showing £0.00 for a CLI that simply never told us would be a
   * confident lie about the cheapest agent in the room.
   */
  lastUsage?(): TurnUsage | undefined;
}

/* ------------------------------------------------------------------ */
/* Claude Code — local, with workspace access                          */
/* ------------------------------------------------------------------ */

export interface ClaudeRunnerOptions {
  model?: string;
  permissionMode: string;
  mcpConfig: string;
  permissionPromptTool: string;
  /**
   * A session to resume, from a previous window.
   *
   * Held outside the runner because the runner is constructed per attach — an id
   * kept only in here cannot outlive the thing that loses it, which is why every
   * reload used to start every agent cold on a conversation the room still
   * remembered.
   */
  resumeSessionId?: string;
  /** Called when the session id changes, so it can be stored. */
  onSession?: (sessionId: string) => void;
}

export class ClaudeCodeRunner implements ModelRunner {
  readonly capability = "workspace" as const;
  private child: ChildProcess | undefined;
  private usage: TurnUsage | undefined;
  /** Session id, so successive turns share context rather than starting cold. */
  private sessionId: string | undefined;

  constructor(private readonly opts: ClaudeRunnerOptions) {
    this.sessionId = opts.resumeSessionId;
  }

  get description(): string {
    return this.opts.model ?? "claude code";
  }

  cancel(): void {
    this.child?.kill();
    this.child = undefined;
    // A cancelled turn leaves the session usable; only a fresh attach resets it.
  }

  lastUsage(): TurnUsage | undefined {
    return this.usage;
  }

  run(ctx: RunContext, log: (line: string) => void): Promise<string> {
    // The roster leads both paths. On a resumed session it is the only place the
    // model can learn that somebody has joined since; on a fresh one the system
    // text is about to go stale for the same reason, so it is stated here too
    // rather than only there.
    const prompt = this.sessionId
      ? `${ctx.roster}\n\n${ctx.unseen}`
      : `${ctx.system}\n\n${ctx.roster}\n\n--- the room so far ---\n${ctx.recent}`;
    const args = [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--mcp-config",
      this.opts.mcpConfig,
      "--strict-mcp-config",
      "--permission-prompt-tool",
      this.opts.permissionPromptTool,
      "--permission-mode",
      this.opts.permissionMode,
    ];
    if (this.opts.model) args.push("--model", this.opts.model);
    // Resume by explicit id rather than --continue, which would latch onto
    // whatever conversation last ran in this folder — possibly the human's own.
    if (this.sessionId) args.push("--resume", this.sessionId);

    log(this.sessionId ? "thinking (resumed session)" : "thinking (new session)");

    return new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;

      let out = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => log(d.toString().trimEnd()));

      child.on("error", (err) => {
        this.child = undefined;
        reject(new Error(`could not start claude: ${err.message}`));
      });

      child.on("close", (code) => {
        this.child = undefined;
        let text = out.trim();
        try {
          const parsed = JSON.parse(text) as {
            session_id?: string;
            result?: string;
            total_cost_usd?: number;
            num_turns?: number;
            duration_ms?: number;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          if (parsed.session_id && parsed.session_id !== this.sessionId) {
            this.sessionId = parsed.session_id;
            this.opts.onSession?.(parsed.session_id);
          }
          // Already in the payload we were parsing, and previously discarded.
          this.usage = {
            costUsd: parsed.total_cost_usd,
            modelTurns: parsed.num_turns,
            durationMs: parsed.duration_ms,
            inputTokens: parsed.usage?.input_tokens,
            outputTokens: parsed.usage?.output_tokens,
            cacheReadTokens: parsed.usage?.cache_read_input_tokens,
          };
          text = String(parsed.result ?? "").trim();
        } catch {
          // Not JSON — fall back to raw output rather than losing the reply.
          this.usage = undefined;
        }
        if (code !== 0 && !text) {
          reject(new Error(`claude exited ${code}`));
          return;
        }
        resolve(text);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Any OpenAI-compatible chat API — conversation only                  */
/* ------------------------------------------------------------------ */

export interface OpenAiCompatOptions {
  /** e.g. https://api.x.ai/v1 — the /chat/completions suffix is added. */
  baseUrl: string;
  model: string;
  apiKey: string;
  label: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Covers Grok, Kimi, DeepSeek, Mistral, Together, Groq and a local Ollama in one
 * adapter, because they all speak the same chat-completions shape.
 *
 * These agents can read the room and contribute, but cannot touch anyone's
 * files. That is a real difference from a Claude Code agent and the room says so
 * rather than letting people assume otherwise.
 */
export class OpenAiCompatRunner implements ModelRunner {
  readonly capability = "conversation" as const;
  private usage: TurnUsage | undefined;
  /** The conversation so far. A stateless HTTP API has no session to resume. */
  private readonly history: ChatMessage[] = [];
  private controller: AbortController | undefined;

  constructor(private readonly opts: OpenAiCompatOptions) {}

  get description(): string {
    return this.opts.model;
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = undefined;
  }

  lastUsage(): TurnUsage | undefined {
    return this.usage;
  }

  async run(ctx: RunContext, log: (line: string) => void): Promise<string> {
    // The roster leads whichever message this turn adds. Stating it once would
    // not survive here either: the request is windowed to a trailing slice, so a
    // roster sent on turn one scrolls out of the conversation while the room it
    // describes is still running.
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: ctx.system });
      this.history.push({
        role: "user",
        content: `${ctx.roster}\n\n--- the room so far ---\n${ctx.recent}`,
      });
    } else {
      this.history.push({ role: "user", content: `${ctx.roster}\n\n${ctx.unseen}` });
    }

    // Keep the request bounded: the system prompt plus a trailing window. A room
    // runs indefinitely, and these APIs charge for every token of history.
    const windowed = [this.history[0], ...this.history.slice(-24)];

    const controller = new AbortController();
    this.controller = controller;
    const endpoint = validateProviderBaseUrl(this.opts.baseUrl);
    if (!endpoint.ok) {
      this.controller = undefined;
      throw new Error(`${this.opts.label}: ${endpoint.reason}`);
    }
    log(`thinking (${this.opts.model} via ${endpoint.url})`);

    let response: Response;
    try {
      response = await fetch(`${endpoint.url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify({ model: this.opts.model, messages: windowed, stream: false }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new Error(
        `${this.opts.label} unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      this.controller = undefined;
    }

    if (!response.ok) {
      // Include the body: these APIs put the useful part there, and a bare
      // status leaves the member guessing between a bad key and a bad model id.
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new Error(`${this.opts.label} returned ${response.status}: ${detail}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // No cost: an OpenAI-compatible endpoint reports tokens and leaves pricing
    // to whoever is paying. Reporting tokens with no dollars is honest; making
    // a figure up from a price list we would have to keep current is not.
    this.usage = payload.usage
      ? { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens }
      : undefined;
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (text) this.history.push({ role: "assistant", content: text });
    return text;
  }
}

/* ------------------------------------------------------------------ */
/* Any local coding-agent CLI — subscription-backed, workspace access   */
/* ------------------------------------------------------------------ */

export interface CliRunnerOptions {
  /** Executable, e.g. "codex" or "gemini". Must be on PATH. */
  command: string;
  /**
   * Arguments, with "{prompt}" replaced by the turn's text. If no placeholder
   * appears, the prompt is written to stdin instead — different CLIs prefer
   * different conventions and both are common.
   */
  args: string[];
  label: string;
  /** Abandon a turn that never returns, rather than wedging the agent. */
  timeoutMs: number;
}

/**
 * Runs another vendor's coding-agent CLI as a room participant.
 *
 * This is the same bargain as Claude Code in BYO mode: the member is already
 * paying for a seat, the tool already has file and shell access to their
 * machine, and the room only has to feed it the conversation and post what
 * comes back. It is strictly better than an API key for both cost and
 * capability.
 *
 * Two things it cannot inherit from the Claude path. Our approval bridge is
 * wired through Claude Code's --permission-prompt-tool, which is specific to it;
 * another CLI will use its own permission model, so a headless run may stall on
 * a prompt nobody can answer unless that CLI is given its own non-interactive
 * flag. And there is no session id to resume, so each turn is fed the recent
 * room rather than continuing a conversation.
 */
export class CliRunner implements ModelRunner {
  readonly capability = "workspace" as const;
  private child: ChildProcess | undefined;

  constructor(private readonly opts: CliRunnerOptions) {}

  get description(): string {
    return this.opts.command;
  }

  cancel(): void {
    this.child?.kill();
    this.child = undefined;
  }

  run(ctx: RunContext, log: (line: string) => void): Promise<string> {
    // Every turn is a fresh process here, so the roster is never stale — but it
    // has to be included for the same reason, since nothing carries over.
    const prompt = `${ctx.system}\n\n${ctx.roster}\n\n--- the room so far ---\n${ctx.recent}\n\n--- new ---\n${ctx.unseen}`;
    const usesPlaceholder = this.opts.args.some((a) => a.includes("{prompt}"));
    const args = this.opts.args.map((a) => a.replace("{prompt}", prompt));

    log(`thinking (${this.opts.command}${usesPlaceholder ? "" : ", prompt on stdin"})`);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.opts.command, args, {
        cwd: ctx.cwd,
        stdio: [usesPlaceholder ? "ignore" : "pipe", "pipe", "pipe"],
      });
      this.child = child;

      const timer = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `${this.opts.label} produced nothing in ${this.opts.timeoutMs / 1000}s. ` +
              `If it is waiting for interactive approval, it needs its own non-interactive flag.`
          )
        );
      }, this.opts.timeoutMs);

      let out = "";
      let err = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr?.on("data", (d: Buffer) => {
        const line = d.toString();
        err += line;
        log(line.trimEnd());
      });

      if (!usesPlaceholder) {
        child.stdin?.write(prompt);
        child.stdin?.end();
      }

      child.on("error", (e) => {
        clearTimeout(timer);
        this.child = undefined;
        reject(new Error(`could not start ${this.opts.command}: ${e.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        this.child = undefined;
        const text = out.trim();
        if (code !== 0) {
          // CLIs commonly print billing/authentication errors to stdout. Treating
          // any stdout as a successful answer put messages such as "Credit
          // balance is too low" into the room under the agent's name.
          const detail = (text || err.trim() || "no diagnostic output")
            .replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "")
            .slice(0, 500);
          reject(new Error(`${this.opts.command} exited ${code}: ${detail}`));
          return;
        }
        resolve(text);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export type ProviderKind = "claude-code" | "cli" | "openai-compatible";

/** The trust boundary chosen for one local agent. */
export type AgentPermission = "readOnly" | "workspace" | "full";

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  /** openai-compatible only. */
  baseUrl?: string;
  /** Offered as the default model name; anything the provider accepts works. */
  suggestedModel?: string;
  /** cli only: the executable and its arguments, "{prompt}" substituted. */
  command?: string;
  args?: string[];
  hint: string;
}

/**
 * Apply Ripieno's per-agent trust boundary to Codex without trusting flags
 * saved by an older build. Other CLIs keep their own arguments because their
 * permission models are provider-specific and guessing would be unsafe.
 *
 * Codex's non-interactive runner cannot surface its terminal approval picker
 * in the editor, so the bounded modes use `approval_policy="never"`: actions
 * inside the selected sandbox work, while attempts to cross it are denied
 * instead of hanging on an invisible prompt.
 */
export function argsForAgentPermission(
  providerId: string,
  args: readonly string[],
  permission?: AgentPermission
): string[] {
  if (providerId !== "codex" || !permission) return [...args];

  const cleaned: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (
      arg === "--dangerously-bypass-approvals-and-sandbox" ||
      arg === "--approve-for-me"
    ) {
      continue;
    }
    if (arg === "--sandbox" || arg === "-s" || arg === "--ask-for-approval" || arg === "-a") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--sandbox=") || arg.startsWith("--ask-for-approval=")) continue;
    if (arg === "--config" || arg === "-c") {
      const value = args[i + 1];
      if (/^(?:approval_policy|approvals_reviewer)=/.test(value ?? "")) {
        i += 1;
        continue;
      }
    }
    if (/^--config=(?:approval_policy|approvals_reviewer)=/.test(arg)) continue;
    cleaned.push(arg);
  }

  const flags =
    permission === "full"
      ? ["--dangerously-bypass-approvals-and-sandbox"]
      : [
          "--sandbox",
          permission === "readOnly" ? "read-only" : "workspace-write",
          "--config",
          'approval_policy="never"',
        ];
  const promptAt = cleaned.findIndex((arg) => arg === "-" || arg.includes("{prompt}"));
  cleaned.splice(promptAt < 0 ? cleaned.length : promptAt, 0, ...flags);
  return cleaned;
}

/** Put a saved model override onto the built-in CLIs that document `--model`. */
export function argsForAgentModel(
  providerId: string,
  args: readonly string[],
  model?: string
): string[] {
  if ((providerId !== "codex" && providerId !== "gemini") || !model) return [...args];

  const cleaned: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--model" || arg === "-m") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--model=")) continue;
    cleaned.push(arg);
  }

  if (providerId === "gemini") return ["--model", model, ...cleaned];
  const promptAt = cleaned.findIndex((arg) => arg === "-" || arg.includes("{prompt}"));
  cleaned.splice(promptAt < 0 ? cleaned.length : promptAt, 0, "--model", model);
  return cleaned;
}

/**
 * Presets, not a closed list — "Custom" takes any OpenAI-compatible endpoint,
 * which is also how a local Ollama joins.
 */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: "codex",
    label: "ChatGPT / Codex (local)",
    kind: "cli",
    command: "codex",
    // Stdin keeps room text out of the process list and avoids command-line
    // length limits. `exec` is Codex's non-interactive path.
    args: ["exec", "--color", "never", "--skip-git-repo-check", "-"],
    hint: "Recommended — your ChatGPT account through Codex CLI, with workspace access.",
  },
  {
    id: "claude-code",
    label: "Claude Code (local)",
    kind: "claude-code",
    hint: "Your Claude subscription. File and shell access, approvals routed to you.",
  },
  {
    id: "gemini",
    label: "Gemini CLI (local)",
    kind: "cli",
    command: "gemini",
    args: ["-p", "{prompt}"],
    hint: "Your Google account, via the gemini CLI. File access. Check the flags suit your version.",
  },
  {
    id: "cli-custom",
    label: "Another local CLI",
    kind: "cli",
    hint: "Any command that takes a prompt and prints a reply. Uses the seat you already pay for.",
  },
  {
    id: "grok",
    kind: "openai-compatible",
    label: "Grok (x.ai)",
    baseUrl: "https://api.x.ai/v1",
    suggestedModel: "grok-4",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "kimi",
    kind: "openai-compatible",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    suggestedModel: "kimi-k2-0905-preview",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "deepseek",
    kind: "openai-compatible",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModel: "deepseek-chat",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "ollama",
    kind: "openai-compatible",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    suggestedModel: "llama3.1",
    hint: "Runs on this machine. Conversation only, and needs Ollama running.",
  },
  {
    id: "custom",
    kind: "openai-compatible",
    label: "Custom OpenAI-compatible endpoint",
    hint: "Any API exposing /chat/completions.",
  },
];

/** API keys belong in SecretStorage, never in settings, which sync and are readable. */
export function secretKeyFor(agentId: string): string {
  return `ripieno.providerKey.${agentId}`;
}

/** Anything running locally can touch files; a hosted chat API cannot. */
export function isWorkspaceProvider(providerId: string): boolean {
  const kind = providerById(providerId)?.kind;
  return kind === "claude-code" || kind === "cli";
}

/** Shown next to an agent so "cannot touch files" is visible, not implied. */
export function describeCapability(capability: RunnerCapability): string {
  return capability === "workspace" ? "workspace access" : "conversation only";
}

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Convenience for callers that only need a display string. */
export function summariseProvider(providerId: string, model?: string): string {
  const preset = providerById(providerId);
  return [preset?.label ?? providerId, model].filter(Boolean).join(" · ");
}
