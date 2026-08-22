const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { parseModelValue, resolveModelRequest } = require("../dist/agentCommands.js");

const agents = [
  { id: "primary", label: "agent" },
  { id: "reviewer", label: "code reviewer" },
  { id: "short", label: "reviewer" },
];

describe("/model request parsing", () => {
  test("a bare command opens a picker instead of printing Claude-only usage", () => {
    assert.deepEqual(resolveModelRequest("", agents), { kind: "pick" });
  });

  test("an exact agent label opens that agent's picker", () => {
    assert.deepEqual(resolveModelRequest("code reviewer", agents), {
      kind: "pick",
      targetId: "reviewer",
    });
  });

  test("an arbitrary provider model targets the primary agent", () => {
    assert.deepEqual(resolveModelRequest("gpt-5.6-terra", agents), {
      kind: "set",
      targetId: "primary",
      model: "gpt-5.6-terra",
    });
  });

  test("a trailing full agent name targets only that agent", () => {
    assert.deepEqual(resolveModelRequest("claude-sonnet-4-5 code reviewer", agents), {
      kind: "set",
      targetId: "reviewer",
      model: "claude-sonnet-4-5",
    });
  });

  test("default clears the provider override", () => {
    assert.deepEqual(resolveModelRequest("DEFAULT reviewer", agents), {
      kind: "set",
      targetId: "short",
      model: undefined,
    });
  });

  test("invalid model strings and an empty agent list fail clearly", () => {
    assert.equal(resolveModelRequest("--dangerous", agents).kind, "error");
    assert.deepEqual(resolveModelRequest("anything", []), {
      kind: "error",
      message: "You have no agents to configure.",
    });
    assert.equal(parseModelValue("model with spaces").ok, false);
  });
});
