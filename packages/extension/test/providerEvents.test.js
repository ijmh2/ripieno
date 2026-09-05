/**
 * Provider streams, against captured output rather than a hopeful mock.
 *
 * The Claude fixture is a real capture: `claude -p --output-format stream-json
 * --verbose` on 2.1.220, run in a scratch directory, with the machine path and
 * session id rewritten. Everything in it — the Bash command line, the file
 * contents that came back in a tool_result, the reasoning-shaped interim text
 * — is the kind of material that must not reach a room, which is why the
 * fixture is a real one and why half of these tests are about what is absent
 * from the output rather than what is present.
 *
 * codex-0.153.1-readonly.jsonl is a real read-only CLI capture, with the thread
 * id replaced. The other Codex fixtures and Gemini fixtures are synthetic.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const {
  ClaudeStreamJsonAdapter,
  CodexJsonlAdapter,
  GeminiCliAdapter,
  OpenAiStreamAdapter,
  createProviderAdapter,
  toolKindFor,
} = require("../dist/providerEvents.js");

const fixture = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

/** Feed a fixture in awkward slices, the way a pipe actually delivers it. */
function drain(adapter, raw, chunk = 37) {
  const events = [];
  for (let at = 0; at < raw.length; at += chunk) {
    events.push(...adapter.push(raw.slice(at, at + chunk)));
  }
  events.push(...adapter.end());
  return events;
}

const summaries = (events) => events.filter((e) => e.type === "tool").map((e) => e.safeSummary);
const phases = (events) => events.filter((e) => e.type === "phase").map((e) => e.phase);

describe("Claude Code stream JSON", () => {
  const raw = fixture("claude-stream-json.jsonl");

  test("a real turn becomes phases, locations and a final reply", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const events = drain(adapter, raw);

    assert.equal(adapter.recognised, true);
    assert.equal(adapter.sessionId, "session-fixture-0001");
    assert.deepEqual(phases(events), [
      "thinking", // system init
      "responding", // "I'll run the command and check the file."
      "running", // Bash
      "thinking", // tool result
      "reading", // Read
      "thinking",
      "editing", // Edit
      "thinking",
      "responding", // "done"
    ]);
    assert.deepEqual(summaries(events), [
      "Running a shell command",
      "Reading note.txt",
      "Editing note.txt",
    ]);
    assert.deepEqual(
      events.filter((e) => e.type === "location").map((e) => e.path),
      ["note.txt", "note.txt"]
    );

    const complete = events.at(-1);
    assert.equal(complete.type, "complete");
    assert.equal(complete.text, "done");
    assert.equal(complete.usage.costUsd, 0.11106499999999998);
    assert.equal(complete.usage.modelTurns, 4);
    assert.equal(complete.usage.durationMs, 6716);
    assert.equal(complete.usage.inputTokens, 6);
    assert.equal(complete.usage.outputTokens, 353);
    assert.equal(complete.usage.cacheReadTokens, 48236);
  });

  test("only the explicit edit proposal may carry provider source text", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const shared = JSON.stringify(
      drain(adapter, raw).filter((event) => event.type !== "complete" && event.type !== "proposal")
    );
    // The command, read result and narration are not proposal material.
    for (const leak of [
      "echo hi",
      "zebra apple",
      "yak apple",
      "I'll run the command",
      "old_string",
      "toolu_",
    ]) {
      assert.equal(shared.includes(leak), false, `"${leak}" must not reach the room`);
    }
    const proposal = drain(new ClaudeStreamJsonAdapter("/work/room"), raw)
      .find((event) => event.type === "proposal");
    assert.equal(proposal.path, "note.txt");
    assert.match(proposal.patch, /-zebra apple/);
    assert.match(proposal.patch, /\+yak apple/);
  });

  test("Task sub-agent edit arguments never become the parent agent's proposal", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const events = adapter.push(`${JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "toolu_task",
      message: {
        content: [{
          type: "tool_use",
          name: "Edit",
          input: {
            file_path: "/work/room/src/private.ts",
            old_string: "sub-agent scratch",
            new_string: "not room-facing",
          },
        }],
      },
    })}\n`);
    assert.equal(events.some((event) => event.type === "proposal"), false);
    assert.equal(JSON.stringify(events).includes("sub-agent scratch"), false);
  });

  test("an absolute path outside the agent's directory is not a location", () => {
    const adapter = new ClaudeStreamJsonAdapter("/somewhere/else");
    const events = drain(adapter, raw);
    assert.equal(events.some((event) => event.type === "location"), false);
    // The work is still described, just without claiming a place for it.
    assert.deepEqual(summaries(events), [
      "Running a shell command",
      "Reading a file",
      "Editing a file",
    ]);
  });

  test("a read with an offset becomes an honest range", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const events = adapter.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/work/room/src/a.ts", offset: 700, limit: 43 },
            },
          ],
        },
      }) + "\n"
    );
    const location = events.find((event) => event.type === "location");
    assert.deepEqual(location, { type: "location", path: "src/a.ts", line: 700, endLine: 742 });
  });

  test("unknown frames are ignored rather than guessed at", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const events = adapter.push(
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}\nnot json at all\n'
    );
    assert.deepEqual(events, []);
  });

  test("only documented user-visible partial text becomes a draft", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const frames = [
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private plan" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "It " } } },
      { type: "stream_event", parent_tool_use_id: "toolu_task", event: { type: "content_block_delta", delta: { type: "text_delta", text: "sub-agent scratch work" } } },
      { type: "stream_event", event: { type: "content_block_delta", parent_tool_use_id: "toolu_nested_task", delta: { type: "text_delta", text: "nested scratch work" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"token":"secret"}' } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "builds." } } },
    ].map((frame) => `${JSON.stringify(frame)}\n`).join("");
    const events = drain(adapter, frames, 11);
    assert.deepEqual(
      events.filter((event) => event.type === "draft").map((event) => event.delta),
      ["It ", "builds."]
    );
    const shared = JSON.stringify(events);
    assert.equal(shared.includes("private plan"), false);
    assert.equal(shared.includes("secret"), false);
    assert.equal(shared.includes("scratch work"), false);
  });

  test("MCP tool names are classified by their leaf", () => {
    assert.equal(toolKindFor("mcp__workspace__workspace_read_file"), "read");
    assert.equal(toolKindFor("mcp__workspace__workspace_run_command"), "run");
    assert.equal(toolKindFor("mcp__workspace__context_add"), "context-add");
    assert.equal(toolKindFor("mcp__somebody__whatever"), "other");
  });

  test("only Ripieno's bundled workspace MCP marks a location as shared", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/private-agent");
    const events = adapter.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__workspace__workspace_read_file",
              input: { path: "src/shared.ts", offset: 4, limit: 2 },
            },
          ],
        },
      }) + "\n"
    );
    assert.deepEqual(events.find((event) => event.type === "location"), {
      type: "location",
      path: "src/shared.ts",
      line: 4,
      endLine: 5,
      locationScope: "shared",
    });

    const spoofed = adapter.push(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "mcp__workspace__invented_read_file",
              input: { path: "src/not-shared.ts" },
            },
          ],
        },
      }) + "\n"
    );
    assert.equal(
      spoofed.find((event) => event.type === "location")?.locationScope,
      undefined,
      "a provider-invented name cannot opt itself into shared coordinates"
    );
  });
});

describe("Codex JSONL", () => {
  test("the captured 0.153.1 stream reports activity and only the final reply", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const events = drain(adapter, fixture("codex-0.153.1-readonly.jsonl"), 1);
    assert.equal(adapter.failure, undefined);
    assert.equal(adapter.sessionId, "probe-thread");
    assert.deepEqual(summaries(events), ["Running a shell command", "Running a shell command"]);
    assert.equal(events.at(-1).text, "Probe complete.");
    assert.equal(events.at(-1).usage.inputTokens, 29708);
    assert.equal(events.at(-1).usage.cacheReadTokens, 26112);
    assert.equal(events.some((e) => e.type === "draft" || e.type === "proposal"), false);
    assert.equal(JSON.stringify(events).includes("ripieno-provider-probe"), false);
  });

  test("terminal failure and truncated output cannot turn interim commentary into a reply", () => {
    for (const terminal of [[], [{ type: "turn.failed", error: { message: "PRIVATE ACCOUNT DETAIL" } }]]) {
      const adapter = new CodexJsonlAdapter();
      const frames = [
        { type: "thread.started", thread_id: "t" },
        { type: "item.completed", item: { type: "agent_message", text: "I'll check the file." } },
        ...terminal,
      ];
      const events = drain(adapter, frames.map(JSON.stringify).join("\n"));
      assert.ok(adapter.failure);
      assert.equal(events.some((e) => e.type === "complete"), false);
      assert.equal(JSON.stringify(events).includes("PRIVATE ACCOUNT DETAIL"), false);
      assert.equal(adapter.failure.includes("PRIVATE ACCOUNT DETAIL"), false);
    }
  });

  test("a transient error followed by terminal success still succeeds", () => {
    const adapter = new CodexJsonlAdapter();
    const events = drain(adapter, [
      { type: "error", message: "Reconnecting: PRIVATE DIAGNOSTIC" },
      { type: "item.completed", item: { type: "agent_message", text: "Ready" } },
      { type: "turn.completed" },
    ].map(JSON.stringify).join("\n"));
    assert.equal(adapter.failure, undefined);
    assert.equal(events.at(-1).text, "Ready");
    assert.equal(JSON.stringify(events).includes("PRIVATE DIAGNOSTIC"), false);
  });

  test("standalone and legacy provider errors are recognised without exposing diagnostics", () => {
    for (const frame of [
      { type: "error", message: "PRIVATE" },
      { id: "1", msg: { type: "error", message: "PRIVATE" } },
    ]) {
      const adapter = new CodexJsonlAdapter();
      const events = drain(adapter, JSON.stringify(frame));
      assert.equal(adapter.recognised, true);
      assert.ok(adapter.failure);
      assert.deepEqual(events, []);
    }
  });
  test("thread events become phases, a location and the reply", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const events = drain(adapter, fixture("codex-thread-events.jsonl"));
    assert.equal(adapter.recognised, true);
    assert.equal(adapter.sessionId, "thread_01HZX");
    assert.deepEqual(phases(events), [
      "thinking", // thread.started
      "thinking", // turn.started
      "thinking", // reasoning, and only that it happened
      "running",
      "editing",
      "responding",
    ]);
    assert.deepEqual(summaries(events), [
      "Running a shell command",
      "Editing packages/relay/src/room.ts",
    ]);
    const complete = events.at(-1);
    assert.equal(complete.type, "complete");
    assert.equal(complete.text, "Fixed the off-by-one in setAgentActivity and added a regression test.");
    assert.equal(complete.usage.inputTokens, 4210);
    assert.equal(complete.usage.outputTokens, 318);
  });

  test("reasoning, command lines and captured output never leave", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const shared = JSON.stringify(
      drain(adapter, fixture("codex-thread-events.jsonl")).filter((e) => e.type !== "complete")
    );
    for (const leak of ["My private plan", "sk-not-a-real-secret", "env | grep", "super-secret-value"]) {
      assert.equal(shared.includes(leak), false, `"${leak}" must not reach the room`);
    }
  });

  test("the earlier {id,msg} protocol maps the same way", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const events = drain(adapter, fixture("codex-legacy-events.jsonl"));
    assert.equal(adapter.recognised, true);
    assert.deepEqual(phases(events), [
      "thinking",
      "thinking",
      "running",
      "thinking",
      "editing",
      "responding",
    ]);
    assert.deepEqual(summaries(events), ["Running a shell command", "Editing src/index.ts"]);
    const complete = events.at(-1);
    assert.equal(complete.text, "Patched src/index.ts.");
    assert.equal(complete.usage.inputTokens, 900);
    const shared = JSON.stringify(events.filter((e) => e.type !== "complete"));
    assert.equal(shared.includes("sk-real-token"), false);
    assert.equal(shared.includes("Hidden chain of thought"), false);
    const proposal = events.find((event) => event.type === "proposal");
    assert.equal(proposal.path, "src/index.ts");
    assert.equal(proposal.patch, "@@ -1 +1 @@");
  });

  test("threaded Codex emits a proposal only before completion and only with an explicit patch", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const started = adapter.push(`${JSON.stringify({
      type: "item.started",
      item: {
        type: "file_change",
        changes: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
      },
    })}\n`);
    assert.equal(started.find((event) => event.type === "proposal")?.patch, "@@ -1 +1 @@\n-old\n+new");

    const completed = adapter.push(`${JSON.stringify({
      type: "item.completed",
      item: {
        type: "file_change",
        changes: [{ path: "src/a.ts", diff: "@@ -1 +1 @@\n-old\n+new" }],
      },
    })}\n`);
    assert.equal(completed.some((event) => event.type === "proposal"), false);
  });

  test("plain text output is not recognised, so the caller keeps its own reply", () => {
    const adapter = new CodexJsonlAdapter("/work/room");
    const events = drain(adapter, "Codex here. I looked at the file and it seems fine.\n");
    assert.deepEqual(events, []);
    assert.equal(adapter.recognised, false);
  });
});

describe("Gemini CLI (documented shape, not a capture)", () => {
  test("the final JSON object supplies the reply", () => {
    const adapter = new GeminiCliAdapter("/work/room");
    const events = drain(adapter, fixture("gemini-result.json"));
    assert.equal(adapter.recognised, true);
    const complete = events.at(-1);
    assert.equal(complete.type, "complete");
    assert.match(complete.text, /^The build fails/);
    assert.equal(complete.usage, undefined, "unverified stats are not reported as usage");
  });

  test("an event stream, if one is present, maps to phases and a location", () => {
    const adapter = new GeminiCliAdapter("/work/room");
    const events = drain(adapter, fixture("gemini-events.jsonl"));
    assert.deepEqual(phases(events), ["reading", "thinking", "responding"]);
    const location = events.find((event) => event.type === "location");
    assert.equal(location.path, "packages/relay/src/room.ts");
    assert.equal(location.line, 700);
    assert.equal(location.endLine, 739);
    assert.equal(JSON.stringify(events).includes("sk-do-not-share"), false);
  });

  test("ordinary prose output leaves the adapter inert", () => {
    const adapter = new GeminiCliAdapter("/work/room");
    assert.deepEqual(drain(adapter, "Here is what I found.\n"), []);
    assert.equal(adapter.recognised, false);
  });
});

describe("OpenAI-compatible streaming", () => {
  test("content deltas assemble one reply and one responding phase", () => {
    const adapter = new OpenAiStreamAdapter();
    const events = drain(adapter, fixture("openai-stream.sse"));
    assert.deepEqual(phases(events), ["responding"]);
    assert.deepEqual(
      events.filter((event) => event.type === "draft").map((event) => event.delta),
      ["It ", "builds."]
    );
    assert.equal(adapter.content, "It builds.");
    assert.equal(adapter.finishReason, "stop");
    assert.equal(adapter.usage.inputTokens, 120);
    assert.equal(adapter.usage.outputTokens, 34);
    assert.deepEqual(adapter.toolCalls(), []);
  });

  test("a tool call is assembled across deltas and announced once", () => {
    const adapter = new OpenAiStreamAdapter();
    const events = drain(adapter, fixture("openai-tool-stream.sse"));
    assert.deepEqual(phases(events), ["thinking"]);
    assert.deepEqual(summaries(events), [
      "Proposing an addition to the room's shared context",
    ]);
    assert.deepEqual(adapter.toolCalls(), [
      {
        id: "call_1",
        name: "context_add",
        arguments: '{"kind":"decision","title":"Relay owns presence"}',
      },
    ]);
    assert.equal(adapter.finishReason, "tool_calls");
  });

  test("keep-alive comments and malformed frames are skipped", () => {
    const adapter = new OpenAiStreamAdapter();
    const events = adapter.push(': ping\n\ndata: {oops\n\ndata: [DONE]\n\n');
    assert.deepEqual(events, []);
    assert.equal(adapter.content, "");
  });
});

test("an adapter is chosen by declared format, never sniffed from output", () => {
  assert.ok(createProviderAdapter("claude-stream-json") instanceof ClaudeStreamJsonAdapter);
  assert.ok(createProviderAdapter("codex-jsonl") instanceof CodexJsonlAdapter);
  assert.ok(createProviderAdapter("gemini-cli") instanceof GeminiCliAdapter);
});
