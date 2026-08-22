const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const {
  CliRunner,
  PROVIDERS,
  argsForAgentModel,
  argsForAgentPermission,
} = require("../dist/runners.js");

const context = {
  system: "You are a room agent.",
  roster: "Room members: Ivan",
  unseen: "Ivan: hello",
  recent: "Ivan: hello",
};

describe("local CLI failures", () => {
  test("non-zero stdout is an error, never an agent reply", async () => {
    const runner = new CliRunner({
      command: process.execPath,
      args: ["-e", "process.stdout.write('Credit balance is too low'); process.exit(7)", "{prompt}"],
      label: "Ivan's agent",
      timeoutMs: 5_000,
    });
    await assert.rejects(
      () => runner.run(context, () => {}),
      /exited 7: Credit balance is too low/
    );
  });

  test("a successful stdout reply is still returned", async () => {
    const runner = new CliRunner({
      command: process.execPath,
      args: ["-e", "process.stdout.write('Ready')", "{prompt}"],
      label: "Ivan's agent",
      timeoutMs: 5_000,
    });
    assert.equal(await runner.run(context, () => {}), "Ready");
  });
});

test("the recommended ChatGPT preset uses Codex non-interactively and sends room text on stdin", () => {
  const codex = PROVIDERS.find((provider) => provider.id === "codex");
  assert.equal(codex.label, "ChatGPT / Codex (local)");
  assert.equal(codex.command, "codex");
  assert.deepEqual(codex.args.slice(0, 2), ["exec", "--color"]);
  assert.ok(codex.args.includes("-"));
  assert.ok(!codex.args.some((arg) => arg.includes("{prompt}")));
});

describe("per-agent Codex permissions", () => {
  const base = ["exec", "--color", "never", "--skip-git-repo-check", "-"];

  test("workspace-only is the low-friction default boundary", () => {
    assert.deepEqual(argsForAgentPermission("codex", base, "workspace"), [
      "exec",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "--config",
      'approval_policy="never"',
      "-",
    ]);
  });

  test("read-only and full access map to distinct Codex boundaries", () => {
    const readOnly = argsForAgentPermission("codex", base, "readOnly");
    assert.ok(readOnly.includes("read-only"));
    assert.ok(!readOnly.includes("--dangerously-bypass-approvals-and-sandbox"));

    const full = argsForAgentPermission("codex", base, "full");
    assert.ok(full.includes("--dangerously-bypass-approvals-and-sandbox"));
    assert.ok(!full.includes("--sandbox"));
    assert.ok(!full.some((arg) => arg.includes("approval_policy")));
  });

  test("changing a choice replaces stale permission flags instead of stacking them", () => {
    const stale = [
      "exec",
      "--approve-for-me",
      "--sandbox",
      "danger-full-access",
      "-c",
      'approval_policy="on-request"',
      "-",
    ];
    assert.deepEqual(argsForAgentPermission("codex", stale, "readOnly"), [
      "exec",
      "--sandbox",
      "read-only",
      "--config",
      'approval_policy="never"',
      "-",
    ]);
  });

  test("other CLIs and legacy agents keep their provider-owned arguments", () => {
    const gemini = ["-p", "{prompt}"];
    assert.deepEqual(argsForAgentPermission("gemini", gemini, "full"), gemini);
    assert.deepEqual(argsForAgentPermission("codex", base), base);
  });
});

describe("per-agent CLI models", () => {
  test("Codex receives its documented --model override before the stdin prompt", () => {
    assert.deepEqual(
      argsForAgentModel("codex", ["exec", "--color", "never", "-"], "gpt-5.6-terra"),
      ["exec", "--color", "never", "--model", "gpt-5.6-terra", "-"]
    );
  });

  test("Gemini receives its documented --model override before --prompt", () => {
    assert.deepEqual(argsForAgentModel("gemini", ["-p", "{prompt}"], "flash"), [
      "--model",
      "flash",
      "-p",
      "{prompt}",
    ]);
  });

  test("a new override replaces a stale built-in flag without touching custom CLIs", () => {
    assert.deepEqual(
      argsForAgentModel("codex", ["exec", "-m", "old", "--model=older", "-"], "new"),
      ["exec", "--model", "new", "-"]
    );
    assert.deepEqual(
      argsForAgentModel("cli-custom", ["--model", "owned-by-custom-cli", "{prompt}"], "ignored"),
      ["--model", "owned-by-custom-cli", "{prompt}"]
    );
  });

  test("no saved override preserves the provider's own configured default", () => {
    const args = ["exec", "--model", "from-configured-args", "-"];
    assert.deepEqual(argsForAgentModel("codex", args), args);
  });
});
