const { test } = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(__dirname, "vscode-stub.js");
  return originalResolve.call(this, request, ...rest);
};
const { ClaudeCodeRunner } = require("../dist/runners.js");
const context = { system: "Test", roster: "Ivan", recent: "Hello", unseen: "Hello", cwd: __dirname };

async function runFixture(raw, exit = 0) {
  const spawn = cp.spawn;
  let args;
  cp.spawn = (_command, argv, options) => {
    args = argv;
    return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(raw)});process.exitCode=${exit}`], options);
  };
  const runner = new ClaudeCodeRunner({ permissionMode: "default", mcpConfig: "{}", permissionPromptTool: "test" });
  const events = [];
  try {
    const reply = await runner.run(context, () => {}, (e) => events.push(e));
    return { reply, events, args, usage: runner.lastUsage() };
  } finally {
    cp.spawn = spawn;
  }
}

test("Claude's captured stream keeps its reply and approval configuration", async () => {
  const raw = fs.readFileSync(path.join(__dirname, "fixtures/claude-stream-json.jsonl"), "utf8");
  const result = await runFixture(raw);
  assert.equal(result.reply, "done");
  assert.equal(result.usage.outputTokens, 353);
  assert.ok(result.args.includes("--include-partial-messages"));
  assert.ok(result.args.includes("--permission-prompt-tool"));
  assert.ok(result.args.includes("--strict-mcp-config"));
});

test("Claude error results never become a room reply, including zero-exit failures", async () => {
  for (const frame of [
    { type: "result", is_error: true, result: "PRIVATE billing detail" },
    { type: "result", subtype: "error_max_turns", errors: ["PRIVATE detail"] },
  ]) {
    await assert.rejects(runFixture(JSON.stringify(frame)), /Claude Code reported a failed turn/);
  }
});

test("Claude's non-zero exit cannot be hidden by a result frame", async () => {
  await assert.rejects(runFixture(JSON.stringify({ type: "result", result: "Not finished" }), 7), /claude exited 7/);
});

test("Claude's missing terminal result is an interrupted turn", async () => {
  await assert.rejects(runFixture(JSON.stringify({ type: "system", subtype: "init" })), /before confirming/);
});
