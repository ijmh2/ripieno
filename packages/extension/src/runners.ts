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

/** What an agent can actually do, which the room shows rather than implies. */
export type RunnerCapability = "workspace" | "conversation";

export interface RunContext {
  /** Standing instructions: who this agent is and how the room works. */
  system: string;
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
}

/* ------------------------------------------------------------------ */
/* Claude Code — local, with workspace access                          */
/* ------------------------------------------------------------------ */

export interface ClaudeRunnerOptions {
  model?: string;
  permissionMode: string;
  mcpConfig: string;
  permissionPromptTool: string;
}

export class ClaudeCodeRunner implements ModelRunner {
  readonly capability = "workspace" as const;
  private child: ChildProcess | undefined;
  /** Session id, so successive turns share context rather than starting cold. */
  private sessionId: string | undefined;

  constructor(private readonly opts: ClaudeRunnerOptions) {}

  get description(): string {
    return this.opts.model ?? "claude code";
  }

  cancel(): void {
    this.child?.kill();
    this.child = undefined;
    // A cancelled turn leaves the session usable; only a fresh attach resets it.
  }

  run(ctx: RunContext, log: (line: string) => void): Promise<string> {
    const prompt = this.sessionId ? ctx.unseen : `${ctx.system}\n\n--- the room so far ---\n${ctx.recent}`;
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
          const parsed = JSON.parse(text) as { session_id?: string; result?: string };
          if (parsed.session_id) this.sessionId = parsed.session_id;
          text = String(parsed.result ?? "").trim();
        } catch {
          // Not JSON — fall back to raw output rather than losing the reply.
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

  async run(ctx: RunContext, log: (line: string) => void): Promise<string> {
    if (this.history.length === 0) {
      this.history.push({ role: "system", content: ctx.system });
      this.history.push({ role: "user", content: `--- the room so far ---\n${ctx.recent}` });
    } else {
      this.history.push({ role: "user", content: ctx.unseen });
    }

    // Keep the request bounded: the system prompt plus a trailing window. A room
    // runs indefinitely, and these APIs charge for every token of history.
    const windowed = [this.history[0], ...this.history.slice(-24)];

    const controller = new AbortController();
    this.controller = controller;
    log(`thinking (${this.opts.model} via ${this.opts.baseUrl})`);

    let response: Response;
    try {
      response = await fetch(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
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
    };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
    if (text) this.history.push({ role: "assistant", content: text });
    return text;
  }
}

/* ------------------------------------------------------------------ */
/* Providers                                                           */
/* ------------------------------------------------------------------ */

export interface ProviderPreset {
  id: string;
  label: string;
  /** Undefined means Claude Code, which runs locally rather than over HTTP. */
  baseUrl?: string;
  /** Offered as the default model name; anything the provider accepts works. */
  suggestedModel?: string;
  hint: string;
}

/**
 * Presets, not a closed list — "Custom" takes any OpenAI-compatible endpoint,
 * which is also how a local Ollama joins.
 */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: "claude-code",
    label: "Claude Code (local)",
    hint: "Full file and shell access to a project on this machine.",
  },
  {
    id: "grok",
    label: "Grok (x.ai)",
    baseUrl: "https://api.x.ai/v1",
    suggestedModel: "grok-4",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "kimi",
    label: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/v1",
    suggestedModel: "kimi-k2-0905-preview",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    suggestedModel: "deepseek-chat",
    hint: "Conversation only — it can read the room but not touch files.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    baseUrl: "http://localhost:11434/v1",
    suggestedModel: "llama3.1",
    hint: "Runs on this machine. Conversation only, and needs Ollama running.",
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible endpoint",
    hint: "Any API exposing /chat/completions.",
  },
];

/** API keys belong in SecretStorage, never in settings, which sync and are readable. */
export function secretKeyFor(agentId: string): string {
  return `mpa.providerKey.${agentId}`;
}

export function isWorkspaceProvider(providerId: string): boolean {
  return providerId === "claude-code";
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
