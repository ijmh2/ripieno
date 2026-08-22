const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  isCodexLoginReady,
  isUnusedLegacyBootstrapAgent,
  nextAgentLabel,
  agentIdFromTreeNode,
  parseCodexModelCatalog,
} = require("../dist/agentSetup.js");

describe("first-run agent migration", () => {
  const bootstrap = { id: "local:default", label: "agent", providerId: "claude-code" };

  test("removes only the untouched, never-used implicit Claude agent", () => {
    assert.equal(isUnusedLegacyBootstrapAgent([bootstrap], {}), true);
  });

  test("preserves user data and any agent that has run successfully", () => {
    for (const agents of [
      [{ ...bootstrap, brief: "review code" }],
      [{ ...bootstrap, cwd: "/work/project" }],
      [{ ...bootstrap, providerId: "codex" }],
      [bootstrap, { id: "local:reviewer:1", label: "reviewer", providerId: "codex" }],
    ]) {
      assert.equal(isUnusedLegacyBootstrapAgent(agents, {}), false);
    }
    assert.equal(
      isUnusedLegacyBootstrapAgent([bootstrap], { "local:default": "session-1" }),
      false
    );
  });
});

describe("agent tree command targeting", () => {
  test("accepts both provider nodes and rendered item ids", () => {
    assert.equal(agentIdFromTreeNode({ agent: { id: "local:test:1" } }, "ivan"), "local:test:1");
    assert.equal(agentIdFromTreeNode({ id: "detached:local:test:1" }, "ivan"), "local:test:1");
    assert.equal(
      agentIdFromTreeNode({ id: "attached:ivan::local:test:1" }, "ivan"),
      "local:test:1"
    );
  });

  test("rejects malformed nodes and never strips another owner's namespace", () => {
    assert.equal(agentIdFromTreeNode(undefined, "ivan"), undefined);
    assert.equal(agentIdFromTreeNode({ id: 123 }, "ivan"), undefined);
    assert.equal(
      agentIdFromTreeNode({ id: "attached:mira::local:test:1" }, "ivan"),
      "mira::local:test:1"
    );
  });
});

describe("quick agent names", () => {
  test("starts normally and increments without asking for setup metadata", () => {
    assert.equal(nextAgentLabel([]), "agent");
    assert.equal(nextAgentLabel(["agent"]), "agent 2");
    assert.equal(nextAgentLabel(["Agent", "agent 2", "reviewer"]), "agent 3");
  });

  test("fills the first available normal name", () => {
    assert.equal(nextAgentLabel(["reviewer", "agent 2"]), "agent");
    assert.equal(nextAgentLabel(["agent", "agent 3"]), "agent 2");
  });
});

describe("Codex login readiness", () => {
  test("requires a successful status command that explicitly says it is logged in", () => {
    assert.equal(isCodexLoginReady(0, "Logged in using ChatGPT"), true);
    assert.equal(isCodexLoginReady(0, "Logged in using an API key"), true);
    assert.equal(isCodexLoginReady(1, "Logged in using ChatGPT"), false);
    assert.equal(isCodexLoginReady(0, "Not logged in"), false);
    assert.equal(isCodexLoginReady(null, ""), false);
  });
});

describe("Codex model catalog", () => {
  test("parses and prioritises visible models after a CLI warning", () => {
    const output =
      "Warning: PATH alias unavailable\n" +
      JSON.stringify({
        models: [
          { slug: "hidden", visibility: "hide", priority: 0 },
          { slug: "gpt-b", display_name: "GPT B", description: "Second", priority: 2 },
          { slug: "gpt-a", display_name: "GPT A", description: "First", priority: 1 },
          { slug: "gpt-a", display_name: "Duplicate", priority: 3 },
        ],
      }) + "\nWarning: cached catalog used";
    assert.deepEqual(parseCodexModelCatalog(output), [
      { slug: "gpt-a", label: "GPT A", description: "First", priority: 1 },
      { slug: "gpt-b", label: "GPT B", description: "Second", priority: 2 },
    ]);
  });

  test("fails closed on malformed or unrelated output", () => {
    assert.deepEqual(parseCodexModelCatalog("not json"), []);
    assert.deepEqual(parseCodexModelCatalog('{"models": nope}'), []);
  });
});
