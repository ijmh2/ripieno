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
 * The Codex and Gemini fixtures are NOT captures. Neither CLI is installed
 * here, so those are written to the documented event shapes; the tests prove
 * the mapping and the refusal to leak, not that either vendor emits exactly
 * this.
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

  test("nothing the provider said reaches an event", () => {
    const adapter = new ClaudeStreamJsonAdapter("/work/room");
    const shared = JSON.stringify(
      drain(adapter, raw).filter((event) => event.type !== "complete")
    );
    // The command that ran, the file it read, the reply text and the model's
    // own interim narration are all in the fixture, and none of them is here.
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

  test("MCP tool names are classified by their leaf", () => {
    assert.equal(toolKindFor("mcp__workspace__read_file"), "read");
    assert.equal(toolKindFor("mcp__workspace__run_command"), "run");
    assert.equal(toolKindFor("mcp__workspace__context_add"), "context-add");
    assert.equal(toolKindFor("mcp__somebody__whatever"), "other");
  });
});

describe("Codex JSONL (documented shape, not a capture)", () => {
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
