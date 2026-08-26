// Native provider streams, turned into the room's own events.
//
// Each adapter reads one provider's output and answers a single question: what
// is observably happening. Nothing it reads is trusted or forwarded — text,
// reasoning, command lines and tool results all stop here, and what leaves is
// a phase, an optional workspace-relative location, and a summary assembled
// from the fixed phrases in runnerEvents.
//
// Adapters are inert by design. An adapter that does not recognise what it is
// being fed emits nothing and reports `recognised === false`, and its runner
// then falls back to the plain-text behaviour it had before. That is what lets
// a CLI whose JSON mode is not configured — or whose version prints something
// else entirely — keep working with coarse `thinking` presence instead of
// producing a confident description of something that never happened.

import type { TurnUsage } from "@ripieno/protocol";
import {
  boundSummary,
  phaseForToolKind,
  safeLine,
  safePath,
  summarisePhase,
  toolEvent,
  type RunnerEvent,
  type ToolKind,
} from "./runnerEvents";

/** Which provider format an adapter reads. */
export type ProviderEventFormat = "claude-stream-json" | "codex-jsonl" | "gemini-cli";

export interface ProviderEventAdapter {
  /** Feed provider stdout. Returns whatever that made observable. */
  push(chunk: string): RunnerEvent[];
  /** Called once at exit, for a trailing partial line or a whole-output parse. */
  end(): RunnerEvent[];
  /** True once the stream has been recognised as this adapter's format. */
  readonly recognised: boolean;
  /** A provider session to resume, when the stream disclosed one. */
  readonly sessionId?: string;
}

/**
 * How much unterminated output an adapter will hold.
 *
 * A provider that never emits a newline must not be able to grow the extension
 * host's memory without limit, and a single event that large is not one we
 * could use anyway.
 */
const MAX_BUFFERED_CHARS = 1_000_000;

/** How much whole output a final-object parse will reconsider. */
const MAX_RETAINED_CHARS = 2_000_000;

abstract class JsonLineAdapter implements ProviderEventAdapter {
  protected buffer = "";
  recognised = false;
  sessionId: string | undefined;

  constructor(protected readonly cwd?: string) {}

  push(chunk: string): RunnerEvent[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFERED_CHARS) {
      // Keep the tail: the useful part of an oversized frame is never the
      // beginning, and holding all of it is the failure mode being avoided.
      this.buffer = this.buffer.slice(-MAX_BUFFERED_CHARS);
    }
    const events: RunnerEvent[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      events.push(...this.line(line));
      index = this.buffer.indexOf("\n");
    }
    return events;
  }

  end(): RunnerEvent[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.trim() ? this.line(rest) : [];
  }

  protected abstract line(raw: string): RunnerEvent[];

  protected parse(raw: string): Record<string, unknown> | undefined {
    const text = raw.trim();
    if (!text.startsWith("{")) return undefined;
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ */
/* Claude Code — `--output-format stream-json`                         */
/* ------------------------------------------------------------------ */

/**
 * Claude's own tool names, mapped to what the room shows.
 *
 * Verified against `claude --output-format stream-json --verbose` on 2.1.220:
 * `system/init`, one `assistant` frame per content block, a `user` frame
 * carrying `tool_result`, and a final `result` frame holding the reply text,
 * the session id and the same usage fields the single-object `json` format
 * reports. Unknown frame types — `rate_limit_event` among them — are ignored.
 */
const CLAUDE_TOOL_KINDS: Record<string, ToolKind> = {
  Read: "read",
  NotebookRead: "read",
  Glob: "search",
  Grep: "search",
  Edit: "edit",
  MultiEdit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  Bash: "run",
  BashOutput: "run",
  KillShell: "run",
  KillBash: "run",
  WebFetch: "fetch",
  WebSearch: "fetch",
};

/** Ripieno's own MCP tools, however a provider happens to namespace them. */
const ROOM_TOOL_KINDS: Record<string, ToolKind> = {
  read_file: "read",
  list_dir: "read",
  list_files: "read",
  search: "search",
  write_file: "edit",
  edit_file: "edit",
  run_command: "run",
  context_read: "context-read",
  context_add: "context-add",
};

export function toolKindFor(name: string): ToolKind {
  if (name.startsWith("mcp__")) {
    const leaf = name.split("__").pop() ?? "";
    return ROOM_TOOL_KINDS[leaf] ?? "other";
  }
  return CLAUDE_TOOL_KINDS[name] ?? ROOM_TOOL_KINDS[name] ?? "other";
}

function locationFrom(
  input: Record<string, unknown> | undefined,
  cwd: string | undefined
): { path?: string; line?: number; endLine?: number } {
  if (!input) return {};
  const path =
    safePath(input.file_path, cwd) ??
    safePath(input.notebook_path, cwd) ??
    safePath(input.filePath, cwd) ??
    safePath(input.path, cwd);
  if (!path) return {};
  // A read with an offset is a claim about a range, which is exactly what the
  // inspector can show honestly: agents patch whole regions, not characters.
  const line = safeLine(input.offset);
  const limit = safeLine(input.limit);
  const endLine = line !== undefined && limit !== undefined ? line + limit - 1 : undefined;
  return { path, line, endLine };
}

export class ClaudeStreamJsonAdapter extends JsonLineAdapter {
  private draftResponded = false;

  protected line(raw: string): RunnerEvent[] {
    const frame = this.parse(raw);
    if (!frame) return [];
    const type = text(frame.type);
    if (!type) return [];
    const events: RunnerEvent[] = [];
    if (type === "system") {
      this.recognised = true;
      const session = text(frame.session_id);
      if (session) this.sessionId = session;
      return [{ type: "phase", phase: "thinking" }];
    }
    if (type === "stream_event") {
      // `--include-partial-messages` wraps Anthropic's documented Messages API
      // stream event. Only text_delta is user-visible response text. Thinking,
      // signatures, usage, diagnostics and tool JSON are deliberately ignored.
      // Claude Code also forwards Task sub-agent stream frames with a parent
      // tool-use id. Their narration is internal work, not the main agent's
      // room-facing reply, so it must stop at this boundary too.
      this.recognised = true;
      const event = record(frame.event);
      if (text(frame.parent_tool_use_id) || text(event?.parent_tool_use_id)) return [];
      const delta = record(event?.delta);
      const piece =
        text(event?.type) === "content_block_delta" && text(delta?.type) === "text_delta"
          ? text(delta?.text)
          : undefined;
      if (!piece) return [];
      const visible: RunnerEvent[] = [];
      if (!this.draftResponded) {
        this.draftResponded = true;
        visible.push({ type: "phase", phase: "responding" });
      }
      visible.push({ type: "draft", delta: piece });
      return visible;
    }
    if (type === "assistant") {
      this.recognised = true;
      const message = record(frame.message);
      const content = Array.isArray(message?.content) ? message?.content : [];
      for (const raw of content as unknown[]) {
        const block = record(raw);
        const kind = text(block?.type);
        if (kind === "text") {
          // Aggregate assistant frames establish phase only. Their text would
          // duplicate the documented text_delta frames handled above.
          events.push({ type: "phase", phase: "responding" });
        } else if (kind === "tool_use") {
          const name = text(block?.name) ?? "";
          const toolKind = toolKindFor(name);
          const where = locationFrom(record(block?.input), this.cwd);
          events.push({ type: "phase", phase: phaseForToolKind(toolKind) });
          events.push(toolEvent(toolKind, name, where.path));
          if (where.path) {
            events.push({
              type: "location",
              path: where.path,
              line: where.line,
              endLine: where.endLine,
            });
          }
        }
      }
      return events;
    }
    if (type === "user") {
      // A tool result came back. Its content is file text or terminal output,
      // so only the fact of it is reported.
      this.recognised = true;
      return [{ type: "phase", phase: "thinking" }];
    }
    if (type === "result") {
      this.recognised = true;
      const session = text(frame.session_id);
      if (session) this.sessionId = session;
      const usageFrame = record(frame.usage);
      const usage: TurnUsage = {
        costUsd: tokens(frame.total_cost_usd),
        modelTurns: tokens(frame.num_turns),
        durationMs: tokens(frame.duration_ms),
        inputTokens: tokens(usageFrame?.input_tokens),
        outputTokens: tokens(usageFrame?.output_tokens),
        cacheReadTokens: tokens(usageFrame?.cache_read_input_tokens),
      };
      return [{ type: "complete", text: (text(frame.result) ?? "").trim(), usage }];
    }
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Codex — `codex exec --json`                                         */
/* ------------------------------------------------------------------ */

/**
 * Codex's JSONL, in both of the shapes its releases have used.
 *
 * NOT verified against a running binary: `codex` is not installed here, so this
 * is written to the documented event schema and to the older `{id, msg}` form
 * that earlier releases emit. It is deliberately inert on anything else — an
 * unrecognised stream produces no events, and `CliRunner` then keeps the plain
 * stdout reply and coarse presence it had before.
 */
export class CodexJsonlAdapter extends JsonLineAdapter {
  private reply = "";
  private usage: TurnUsage | undefined;
  private finished = false;

  /**
   * Finish a recognised stream that stopped without saying so.
   *
   * A turn that ends without its terminal frame — a kill, a crash, an older
   * release that does not emit one — must still hand back the reply it did
   * produce. Otherwise the runner has a stream it understood and no text, and
   * the honest fallback would be posting raw JSONL into the room.
   */
  end(): RunnerEvent[] {
    const events = super.end();
    if (this.recognised && !this.finished) {
      this.finished = true;
      events.push({ type: "complete", text: this.reply.trim(), usage: this.usage });
    }
    return events;
  }

  protected line(raw: string): RunnerEvent[] {
    const frame = this.parse(raw);
    if (!frame) return [];
    const thread = record(frame.msg);
    return thread ? this.legacy(thread) : this.threaded(frame);
  }

  /** `{"type":"item.completed","item":{...}}` and its siblings. */
  private threaded(frame: Record<string, unknown>): RunnerEvent[] {
    const type = text(frame.type);
    if (!type) return [];
    if (type === "thread.started" || type === "turn.started") {
      this.recognised = true;
      const id = text(frame.thread_id);
      if (id) this.sessionId = id;
      return [{ type: "phase", phase: "thinking" }];
    }
    if (type === "turn.completed" || type === "turn.failed") {
      this.recognised = true;
      const usage = record(frame.usage);
      if (usage) {
        this.usage = {
          inputTokens: tokens(usage.input_tokens),
          outputTokens: tokens(usage.output_tokens),
          cacheReadTokens: tokens(usage.cached_input_tokens),
        };
      }
      this.finished = true;
      return [{ type: "complete", text: this.reply.trim(), usage: this.usage }];
    }
    if (type !== "item.started" && type !== "item.updated" && type !== "item.completed") return [];
    const item = record(frame.item);
    const itemType = text(item?.type);
    if (!item || !itemType) return [];
    this.recognised = true;
    const complete = type === "item.completed";
    switch (itemType) {
      case "agent_message": {
        const message = text(item.text) ?? text(item.message);
        if (complete && message) this.reply = message;
        return [{ type: "phase", phase: "responding" }];
      }
      case "reasoning":
        // Hidden reasoning is never shared, in any form. Only that it happened.
        return [{ type: "phase", phase: "thinking" }];
      case "command_execution":
        return [{ type: "phase", phase: "running" }, toolEvent("run", "shell")];
      case "file_change":
        return this.fileChange(item);
      case "mcp_tool_call":
        return [toolEvent("other", text(item.tool) ?? text(item.name))];
      case "web_search":
        return [{ type: "phase", phase: "running" }, toolEvent("fetch", "web_search")];
      case "todo_list":
        return [{ type: "phase", phase: "thinking" }];
      default:
        return [];
    }
  }

  private fileChange(item: Record<string, unknown>): RunnerEvent[] {
    const changes = Array.isArray(item.changes) ? (item.changes as unknown[]) : [];
    const first = record(changes[0]);
    const path = safePath(first?.path, this.cwd);
    const events: RunnerEvent[] = [
      { type: "phase", phase: "editing" },
      toolEvent("edit", "apply_patch", path),
    ];
    if (path) events.push({ type: "location", path });
    return events;
  }

  /** The earlier `{"id":"0","msg":{"type":...}}` protocol. */
  private legacy(msg: Record<string, unknown>): RunnerEvent[] {
    const type = text(msg.type);
    if (!type) return [];
    this.recognised = true;
    switch (type) {
      case "task_started":
        return [{ type: "phase", phase: "thinking" }];
      case "agent_reasoning":
      case "agent_reasoning_delta":
        return [{ type: "phase", phase: "thinking" }];
      case "agent_message": {
        const message = text(msg.message);
        if (message) this.reply = message;
        return [{ type: "phase", phase: "responding" }];
      }
      case "exec_command_begin":
        return [{ type: "phase", phase: "running" }, toolEvent("run", "shell")];
      case "exec_command_end":
        return [{ type: "phase", phase: "thinking" }];
      case "patch_apply_begin": {
        const changes = record(msg.changes);
        const path = changes ? safePath(Object.keys(changes)[0], this.cwd) : undefined;
        const events: RunnerEvent[] = [
          { type: "phase", phase: "editing" },
          toolEvent("edit", "apply_patch", path),
        ];
        if (path) events.push({ type: "location", path });
        return events;
      }
      case "token_count": {
        const info = record(msg.info);
        const total = record(info?.total_token_usage);
        if (total) {
          this.usage = {
            inputTokens: tokens(total.input_tokens),
            outputTokens: tokens(total.output_tokens),
            cacheReadTokens: tokens(total.cached_input_tokens),
          };
        }
        return [];
      }
      case "task_complete": {
        const last = text(msg.last_agent_message);
        if (last) this.reply = last;
        this.finished = true;
        return [{ type: "complete", text: this.reply.trim(), usage: this.usage }];
      }
      default:
        return [];
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gemini CLI                                                          */
/* ------------------------------------------------------------------ */

/**
 * The Gemini CLI, in its documented `--output-format json` shape.
 *
 * NOT verified against a running binary: `gemini` is not installed here. The
 * final-object shape (`{"response": ..., "stats": ...}`) is the CLI's
 * documented JSON output and is handled in `end()`, because that object is
 * pretty-printed across many lines rather than emitted as JSONL. A tolerant
 * per-line branch handles a `{"type": ...}` event stream if one is present,
 * and does nothing at all if it is not.
 */
export class GeminiCliAdapter extends JsonLineAdapter {
  private raw = "";
  private reply = "";

  push(chunk: string): RunnerEvent[] {
    if (this.raw.length < MAX_RETAINED_CHARS) this.raw += chunk;
    return super.push(chunk);
  }

  protected line(raw: string): RunnerEvent[] {
    const frame = this.parse(raw);
    const type = frame ? text(frame.type) : undefined;
    if (!frame || !type) return [];
    switch (type) {
      case "tool_call":
      case "tool_call_request": {
        this.recognised = true;
        const name = text(frame.name) ?? text(record(frame.tool)?.name);
        const kind = name ? toolKindFor(name) : "other";
        const where = locationFrom(record(frame.args) ?? record(frame.input), this.cwd);
        const events: RunnerEvent[] = [
          { type: "phase", phase: phaseForToolKind(kind) },
          toolEvent(kind, name, where.path),
        ];
        if (where.path) {
          events.push({ type: "location", path: where.path, line: where.line, endLine: where.endLine });
        }
        return events;
      }
      case "tool_call_response":
        this.recognised = true;
        return [{ type: "phase", phase: "thinking" }];
      case "content":
      case "assistant":
        this.recognised = true;
        return [{ type: "phase", phase: "responding" }];
      default:
        return [];
    }
  }

  end(): RunnerEvent[] {
    const events = super.end();
    const whole = this.raw.trim();
    this.raw = "";
    if (!whole.startsWith("{")) return events;
    try {
      const parsed: unknown = JSON.parse(whole);
      const frame = record(parsed);
      const response = frame ? text(frame.response) : undefined;
      if (response === undefined) return events;
      this.recognised = true;
      this.reply = response;
      // No usage: the CLI's `stats` shape is not something this repository has
      // verified, and reporting invented token counts would be worse than
      // reporting none — "it does not say" is already a meaning the room has.
      return [...events, { type: "complete", text: this.reply.trim() }];
    } catch {
      return events;
    }
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI-compatible streaming                                         */
/* ------------------------------------------------------------------ */

/** How many tool calls one streamed turn may accumulate. */
const MAX_STREAMED_TOOL_CALLS = 8;
/** How long one tool call's JSON arguments may grow. */
const MAX_TOOL_ARGUMENT_CHARS = 8_000;

export interface StreamedToolCall {
  id: string;
  name: string;
  /** Raw JSON text as the provider streamed it. Parsed by the caller. */
  arguments: string;
}

/**
 * Server-sent chat-completions chunks.
 *
 * This is the documented OpenAI streaming shape, which every compatible
 * endpoint in the provider list implements: `data:` lines carrying
 * `choices[].delta`, a terminating `data: [DONE]`, and — with
 * `stream_options.include_usage` — a final chunk whose `usage` is the whole
 * turn's. The adapter also exposes the assembled content and tool calls,
 * because the runner needs them to finish the turn.
 */
export class OpenAiStreamAdapter {
  recognised = false;
  content = "";
  finishReason: string | undefined;
  usage: TurnUsage | undefined;
  private buffer = "";
  private responded = false;
  private readonly calls = new Map<number, { id: string; name: string; arguments: string }>();
  private readonly announced = new Set<number>();

  push(chunk: string): RunnerEvent[] {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFERED_CHARS) this.buffer = this.buffer.slice(-MAX_BUFFERED_CHARS);
    const events: RunnerEvent[] = [];
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      events.push(...this.line(line));
      index = this.buffer.indexOf("\n");
    }
    return events;
  }

  end(): RunnerEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? this.line(rest) : [];
  }

  toolCalls(): StreamedToolCall[] {
    return [...this.calls.values()].filter((call) => call.name);
  }

  private line(line: string): RunnerEvent[] {
    if (!line.startsWith("data:")) return [];
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return [];
    let frame: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(payload);
      frame = record(parsed);
    } catch {
      return [];
    }
    if (!frame) return [];
    this.recognised = true;
    const events: RunnerEvent[] = [];
    const usage = record(frame.usage);
    if (usage) {
      this.usage = {
        inputTokens: tokens(usage.prompt_tokens),
        outputTokens: tokens(usage.completion_tokens),
      };
    }
    const choice = record((Array.isArray(frame.choices) ? frame.choices : [])[0]);
    if (!choice) return events;
    const finish = text(choice.finish_reason);
    if (finish) this.finishReason = finish;
    const delta = record(choice.delta);
    const piece = text(delta?.content);
    if (piece) {
      this.content += piece;
      if (!this.responded) {
        this.responded = true;
        events.push({ type: "phase", phase: "responding" });
      }
      events.push({ type: "draft", delta: piece });
    }
    const calls = Array.isArray(delta?.tool_calls) ? (delta?.tool_calls as unknown[]) : [];
    for (const rawCall of calls) {
      const call = record(rawCall);
      if (!call) continue;
      const index = typeof call.index === "number" ? call.index : 0;
      if (!this.calls.has(index) && this.calls.size >= MAX_STREAMED_TOOL_CALLS) continue;
      const existing = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
      const fn = record(call.function);
      const id = text(call.id);
      if (id) existing.id = id.slice(0, 128);
      const name = text(fn?.name);
      if (name) existing.name = name.slice(0, 64);
      const args = text(fn?.arguments);
      if (args && existing.arguments.length < MAX_TOOL_ARGUMENT_CHARS) {
        existing.arguments += args;
      }
      this.calls.set(index, existing);
      if (existing.name && !this.announced.has(index)) {
        this.announced.add(index);
        const kind = toolKindFor(existing.name);
        events.push({ type: "phase", phase: phaseForToolKind(kind) });
        events.push(toolEvent(kind, existing.name));
      }
    }
    return events;
  }
}

/* ------------------------------------------------------------------ */

export function createProviderAdapter(
  format: ProviderEventFormat,
  cwd?: string
): ProviderEventAdapter {
  switch (format) {
    case "claude-stream-json":
      return new ClaudeStreamJsonAdapter(cwd);
    case "codex-jsonl":
      return new CodexJsonlAdapter(cwd);
    case "gemini-cli":
      return new GeminiCliAdapter(cwd);
  }
}

/** The coarse presence a runner reports when no adapter can say more. */
export function coarseThinking(): RunnerEvent[] {
  return [{ type: "phase", phase: "thinking" }];
}

/** Exported so a caller can label an unadapted turn the same way. */
export const COARSE_SUMMARY = boundSummary(summarisePhase("thinking"));
