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
import type { RunnerEvent, RunnerEventSink } from "./runnerEvents";
import {
  OpenAiStreamAdapter,
  createProviderAdapter,
  type ProviderEventAdapter,
  type ProviderEventFormat,
} from "./providerEvents";

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
  /** Bounded, attributed shared room memory refreshed on every turn. */
  context?: string;
  /** The whole recent room, sent when there is no prior session to build on. */
  recent: string;
  /** Where a workspace-capable runner should work. */
  cwd?: string;
  /**
   * Structured room tools this provider may call, when it has a tool channel.
   *
   * Claude Code reaches `context_add` through MCP and a local CLI through the
   * directive block in its reply; an OpenAI-compatible endpoint has native
   * function calling, so it is offered the same two tools directly rather than
   * being the one provider that can only read shared memory.
   */
  tools?: RunnerTool[];
  /** Executes one of `tools`. Absent when the host offers none. */
  callTool?: (name: string, input: Record<string, unknown>) => Promise<RunnerToolResult>;
}

/** One room tool, described the way a chat-completions API expects. */
export interface RunnerTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}

export interface RunnerToolResult {
  content: string;
  isError: boolean;
}

export interface ModelRunner {
  readonly capability: RunnerCapability;
  /** A short name for the model, shown beside the agent. */
  readonly description: string;
  /**
   * Run one turn.
   *
   * Still resolves to the final text, because that is what the room posts and
   * what every existing caller expects. `onEvent` is additive: it reports what
   * the turn is observably doing while it happens, and a caller that does not
   * pass it gets exactly the behaviour it had before.
   */
  run(ctx: RunContext, log: (line: string) => void, onEvent?: RunnerEventSink): Promise<string>;
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

/**
 * How much unstructured stdout a runner keeps for its fallback path.
 *
 * Only ever read when a provider's structured stream was not recognised at
 * all, so this is a bound on a rescue, not on ordinary operation.
 */
const MAX_FALLBACK_CHARS = 200_000;

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

  run(ctx: RunContext, log: (line: string) => void, onEvent?: RunnerEventSink): Promise<string> {
    // The roster leads both paths. On a resumed session it is the only place the
    // model can learn that somebody has joined since; on a fresh one the system
    // text is about to go stale for the same reason, so it is stated here too
    // rather than only there.
    const shared = ctx.context ? `${ctx.context}\n\n` : "";
    const prompt = this.sessionId
      ? `${ctx.roster}\n\n${shared}${ctx.unseen}`
      : `${ctx.system}\n\n${ctx.roster}\n\n${shared}--- the room so far ---\n${ctx.recent}`;
    const args = [
      "-p",
      prompt,
      // Streaming frames rather than one final object. The last frame is the
      // same `result` payload the single-object format returns — same session
      // id, same reply, same usage — so nothing is given up, and everything
      // before it is what the room can honestly show while the turn runs.
      "--output-format",
      "stream-json",
      // Claude refuses stream-json under --print without this.
      "--verbose",
      // Emits documented `stream_event` / `text_delta` frames. The adapter
      // accepts only those user-visible deltas and ignores thinking/diagnostics.
      "--include-partial-messages",
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

    // Reject rather than throw: `run` is declared Promise<string> and a caller
    // using .catch() would otherwise get a synchronous exception instead.
    if (!ctx.cwd) return Promise.reject(missingWorkingDirectory());

    log(this.sessionId ? "thinking (resumed session)" : "thinking (new session)");
    onEvent?.({ type: "phase", phase: "thinking" });

    return new Promise<string>((resolve, reject) => {
      const child = spawn("claude", args, { cwd: ctx.cwd, stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      const adapter = createProviderAdapter("claude-stream-json", ctx.cwd);
      let completed: Extract<RunnerEvent, { type: "complete" }> | undefined;
      const consume = (events: RunnerEvent[]): void => {
        for (const event of events) {
          if (event.type === "complete") completed = event;
          onEvent?.(event);
        }
      };

      // Retained only until the stream identifies itself, so an unparsed run
      // still has something to fall back on without holding every frame of a
      // long turn in memory.
      let fallback = "";
      child.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        if (!adapter.recognised && fallback.length < MAX_FALLBACK_CHARS) fallback += chunk;
        consume(adapter.push(chunk));
      });
      child.stderr?.on("data", (d: Buffer) => log(d.toString().trimEnd()));

      child.on("error", (err) => {
        this.child = undefined;
        reject(new Error(`could not start claude: ${err.message}`));
      });

      child.on("close", (code) => {
        this.child = undefined;
        consume(adapter.end());
        if (adapter.sessionId && adapter.sessionId !== this.sessionId) {
          this.sessionId = adapter.sessionId;
          this.opts.onSession?.(adapter.sessionId);
        }
        let text: string;
        if (completed) {
          text = completed.text;
          this.usage = completed.usage;
        } else if (adapter.recognised) {
          // The stream was ours but never finished — a kill, a crash, a
          // cancelled turn. Half a stream is not a reply.
          text = "";
          this.usage = undefined;
        } else {
          text = this.parseSingleObject(fallback.trim());
        }
        if (code !== 0 && !text) {
          reject(new Error(`claude exited ${code}`));
          return;
        }
        resolve(text);
      });
    });
  }

  /**
   * The pre-streaming `--output-format json` payload.
   *
   * Kept as the fallback for a build of Claude Code that does not produce the
   * streaming frames: a member whose CLI is older should get their reply, not
   * an empty room message and a confusing error.
   */
  private parseSingleObject(raw: string): string {
    try {
      const parsed = JSON.parse(raw) as {
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
      this.usage = {
        costUsd: parsed.total_cost_usd,
        modelTurns: parsed.num_turns,
        durationMs: parsed.duration_ms,
        inputTokens: parsed.usage?.input_tokens,
        outputTokens: parsed.usage?.output_tokens,
        cacheReadTokens: parsed.usage?.cache_read_input_tokens,
      };
      return String(parsed.result ?? "").trim();
    } catch {
      // Not JSON — fall back to raw output rather than losing the reply.
      this.usage = undefined;
      return raw;
    }
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

/** One message in the trailing window sent to a chat-completions endpoint. */
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Assistant turns that called tools carry them back verbatim. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Tool results are correlated by the id the model chose. */
  tool_call_id?: string;
}

/** How many times one turn may call tools before it must answer. */
const MAX_TOOL_ROUNDS = 3;

/**
 * Covers Grok, Kimi, DeepSeek, Mistral, Together, Groq and a local Ollama in one
 * adapter, because they all speak the same chat-completions shape.
 *
 * These agents can read the room and contribute, but cannot touch anyone's
 * files. That is a real difference from a Claude Code agent and the room says so
 * rather than letting people assume otherwise.
 *
 * The request streams user-facing assistant content into the room's bounded
 * ephemeral draft channel. Tool calls arrive on the same provider stream but
 * are mapped only to safe activity events; this is also how a hosted model gets
 * `context_add` rather than only being able to read.
 */
export class OpenAiCompatRunner implements ModelRunner {
  readonly capability = "conversation" as const;
  private usage: TurnUsage | undefined;
  /** The conversation so far. A stateless HTTP API has no session to resume. */
  private readonly history: ChatMessage[] = [];
  private controller: AbortController | undefined;
  /**
   * Whether this endpoint has refused a streamed request.
   *
   * "OpenAI-compatible" is a family resemblance rather than a specification.
   * One endpoint that rejects `stream` should cost one wasted request, not one
   * per turn forever.
   */
  private streamingUnsupported = false;

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

  async run(
    ctx: RunContext,
    log: (line: string) => void,
    onEvent?: RunnerEventSink
  ): Promise<string> {
    const shared = ctx.context ? `${ctx.context}\n\n` : "";
    // The roster leads whichever message this turn adds. Stating it once would
    // not survive here either: the request is windowed to a trailing slice, so a
    // roster sent on turn one scrolls out of the conversation while the room it
    // describes is still running.
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: ctx.system });
      this.history.push({
        role: "user",
        content: `${ctx.roster}\n\n${shared}--- the room so far ---\n${ctx.recent}`,
      });
    } else {
      this.history.push({ role: "user", content: `${ctx.roster}\n\n${shared}${ctx.unseen}` });
    }

    const endpoint = validateProviderBaseUrl(this.opts.baseUrl);
    if (!endpoint.ok) {
      throw new Error(`${this.opts.label}: ${endpoint.reason}`);
    }
    log(`thinking (${this.opts.model} via ${endpoint.url})`);
    onEvent?.({ type: "phase", phase: "thinking" });

    const tools =
      ctx.tools && ctx.tools.length > 0 && ctx.callTool
        ? ctx.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          }))
        : undefined;

    let text = "";
    for (let round = 0; ; round += 1) {
      const turn = await this.completion(endpoint.url, tools, onEvent);
      this.usage = turn.usage;
      const calls = turn.toolCalls;
      if (calls.length === 0 || !ctx.callTool || round >= MAX_TOOL_ROUNDS) {
        text = turn.text;
        break;
      }
      // Keep the assistant's own call in the history: a tool result with no
      // call before it is a malformed conversation to every one of these APIs.
      this.history.push({
        role: "assistant",
        content: turn.text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      for (const call of calls) {
        let input: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(call.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            input = parsed as Record<string, unknown>;
          }
        } catch {
          input = {};
        }
        const result = await ctx.callTool(call.name, input);
        log(`tool ${call.name}: ${result.isError ? "refused" : "ok"}`);
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.content.slice(0, 4_000),
        });
      }
    }

    if (text) this.history.push({ role: "assistant", content: text });
    onEvent?.({ type: "complete", text, usage: this.usage });
    return text;
  }

  /**
   * Keep the request bounded: the system prompt plus a trailing window.
   *
   * A room runs indefinitely, and these APIs charge for every token of history.
   * A window that opened on a tool result would be rejected as malformed, so
   * any orphaned results at the front are dropped with it.
   */
  private window(): ChatMessage[] {
    const tail = this.history.slice(-24);
    while (tail.length > 0 && tail[0].role === "tool") tail.shift();
    return [this.history[0], ...tail];
  }

  private async completion(
    url: string,
    tools: unknown[] | undefined,
    onEvent?: RunnerEventSink
  ): Promise<{ text: string; toolCalls: ReturnType<OpenAiStreamAdapter["toolCalls"]>; usage?: TurnUsage }> {
    const stream = !this.streamingUnsupported;
    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: this.window(),
      stream,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const controller = new AbortController();
    this.controller = controller;
    let response: Response;
    try {
      response = await fetch(`${url}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      this.controller = undefined;
      throw new Error(
        `${this.opts.label} unreachable: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (!response.ok) {
      // Include the body: these APIs put the useful part there, and a bare
      // status leaves the member guessing between a bad key and a bad model id.
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      this.controller = undefined;
      if (stream && requestShapeRejected(response.status) && /stream/i.test(detail)) {
        // This endpoint speaks the family's dialect but not this word of it.
        this.streamingUnsupported = true;
        return this.completion(url, tools, onEvent);
      }
      throw new Error(`${this.opts.label} returned ${response.status}: ${detail}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!stream || !contentType.includes("event-stream")) {
      // An endpoint that ignored `stream` and answered in one piece is still a
      // working endpoint; take the answer rather than failing on the framing.
      const payload = (await response.json().catch(() => ({}))) as {
        choices?: Array<{
          message?: {
            content?: string;
            tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
          };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      this.controller = undefined;
      const message = payload.choices?.[0]?.message;
      const toolCalls = (message?.tool_calls ?? [])
        .filter((call) => typeof call.function?.name === "string")
        .slice(0, 8)
        .map((call) => ({
          id: String(call.id ?? "").slice(0, 128),
          name: String(call.function?.name ?? "").slice(0, 64),
          arguments: String(call.function?.arguments ?? "").slice(0, 8_000),
        }));
      if (toolCalls.length > 0) onEvent?.({ type: "phase", phase: "thinking" });
      return {
        text: message?.content?.trim() ?? "",
        toolCalls,
        // No cost: an OpenAI-compatible endpoint reports tokens and leaves
        // pricing to whoever is paying. Reporting tokens with no dollars is
        // honest; making a figure up from a price list we would have to keep
        // current is not.
        usage: payload.usage
          ? {
              inputTokens: payload.usage.prompt_tokens,
              outputTokens: payload.usage.completion_tokens,
            }
          : undefined,
      };
    }

    const adapter = new OpenAiStreamAdapter();
    try {
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const event of adapter.push(decoder.decode(value, { stream: true }))) {
          onEvent?.(event);
        }
      }
      for (const event of adapter.end()) onEvent?.(event);
    } finally {
      this.controller = undefined;
    }
    return {
      text: adapter.content.trim(),
      toolCalls: adapter.toolCalls(),
      usage: adapter.usage,
    };
  }
}

/** Statuses that mean "this request was shaped wrong", not "you may not". */
function requestShapeRejected(status: number): boolean {
  return status === 400 || status === 404 || status === 415 || status === 422 || status === 501;
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
  /**
   * The structured format this CLI's configuration says it emits, if any.
   *
   * Declared by the provider preset rather than guessed from the output: a
   * custom CLI keeps coarse `thinking` presence, because inventing a parser for
   * an unknown format would produce confident descriptions of work that may not
   * be happening. Even a declared parser stays inert until it actually
   * recognises the stream, so a CLI whose JSON mode is not switched on behaves
   * exactly as it did before.
   */
  eventFormat?: ProviderEventFormat;
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
  private usage: TurnUsage | undefined;

  constructor(private readonly opts: CliRunnerOptions) {}

  get description(): string {
    return this.opts.command;
  }

  cancel(): void {
    this.child?.kill();
    this.child = undefined;
  }

  /**
   * Undefined unless this CLI's own event stream reported it.
   *
   * A subscription CLI usually says nothing about tokens and never about
   * money, and "it does not report" is a meaning the room already has.
   */
  lastUsage(): TurnUsage | undefined {
    return this.usage;
  }

  run(ctx: RunContext, log: (line: string) => void, onEvent?: RunnerEventSink): Promise<string> {
    // Every turn is a fresh process here, so the roster is never stale — but it
    // has to be included for the same reason, since nothing carries over.
    const shared = ctx.context ? `${ctx.context}\n\n` : "";
    const prompt = `${ctx.system}\n\n${ctx.roster}\n\n${shared}--- the room so far ---\n${ctx.recent}\n\n--- new ---\n${ctx.unseen}`;
    const usesPlaceholder = this.opts.args.some((a) => a.includes("{prompt}"));
    const args = this.opts.args.map((a) => a.replace("{prompt}", prompt));

    // Reject rather than throw: `run` is declared Promise<string> and a caller
    // using .catch() would otherwise get a synchronous exception instead.
    if (!ctx.cwd) return Promise.reject(missingWorkingDirectory());

    log(`thinking (${this.opts.command}${usesPlaceholder ? "" : ", prompt on stdin"})`);
    onEvent?.({ type: "phase", phase: "thinking" });
    const adapter: ProviderEventAdapter | undefined = this.opts.eventFormat
      ? createProviderAdapter(this.opts.eventFormat, ctx.cwd)
      : undefined;
    let completed: Extract<RunnerEvent, { type: "complete" }> | undefined;
    const consume = (events: RunnerEvent[]): void => {
      for (const event of events) {
        if (event.type === "complete") completed = event;
        onEvent?.(event);
      }
    };

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
      child.stdout?.on("data", (d: Buffer) => {
        const chunk = d.toString();
        out += chunk;
        if (adapter) consume(adapter.push(chunk));
      });
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
        if (adapter) consume(adapter.end());
        this.usage = completed?.usage;
        // A recognised stream owns the reply, whether or not it finished: its
        // raw form is machine output, not something to post under an agent's
        // name. An unrecognised one leaves the previous plain-text behaviour
        // exactly as it was.
        const text = adapter?.recognised ? completed?.text ?? "" : out.trim();
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
  /**
   * cli only: the structured output format this CLI is documented to emit.
   *
   * Its presence is the configuration declaring a parser. The parser stays
   * inert until the stream actually looks like that format, so declaring one
   * for a CLI that is not currently invoked in its JSON mode changes nothing.
   */
  eventFormat?: ProviderEventFormat;
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
    // Declared, not switched on: the arguments above are unchanged, so this
    // does nothing until a member adds Codex's own JSON flag to them. Adding
    // that flag here would change what every new Codex agent runs on the
    // strength of a format this repository has not been able to verify.
    eventFormat: "codex-jsonl",
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
    eventFormat: "gemini-cli",
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
/**
 * Refuse to start a workspace agent that has nowhere to work.
 *
 * `spawn` with `cwd: undefined` does not fail — the child quietly inherits the
 * parent's directory, which for an extension host is `/`. macOS makes that
 * read-only under SIP, so it surfaced as EROFS and an agent reporting that the
 * product had no writable workspace; on Linux the same path is writable and the
 * agent would have started editing the filesystem root instead. Neither is what
 * anyone configured, so this stops before the process exists rather than
 * translating the failure afterwards.
 */
export function missingWorkingDirectory(): Error {
  return new Error(
    "This agent has no working directory, so it cannot read, write or run commands. " +
      "Set one by editing the agent and choosing its folder, or open a folder in the " +
      "editor window running it."
  );
}

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
