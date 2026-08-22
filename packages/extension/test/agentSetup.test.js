const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  isCodexLoginReady,
  isUnusedLegacyBootstrapAgent,
  nextAgentLabel,
  agentIdFromTreeNode,
  parseCodexModelCatalog,
  shouldStartAddAgentForAttach,
  needsSharedRoomAgentConsent,
  decideOnboarding,
  effectiveResponseMode,
  orderDetectedProviderIds,
  responseModeForNewAgent,
  safestUsablePermission,
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

describe("attach command onboarding", () => {
  test("starts Add Agent only for the untargeted first-run CTA", () => {
    assert.equal(shouldStartAddAgentForAttach(0, undefined), true);
    assert.equal(shouldStartAddAgentForAttach(1, undefined), false);
    assert.equal(shouldStartAddAgentForAttach(0, "local:missing"), false);
    assert.equal(shouldStartAddAgentForAttach(2, "local:missing"), false);
  });
});

describe("shared-room workspace consent", () => {
  test("asks before a remote room can steer a local workspace agent", () => {
    assert.equal(
      needsSharedRoomAgentConsent(true, "wss://relay.example", undefined, "standup", false),
      true
    );
  });

  test("does not ask for conversation-only agents, solo rooms, or an approved attach", () => {
    assert.equal(
      needsSharedRoomAgentConsent(false, "wss://relay.example", undefined, "standup", false),
      false
    );
    assert.equal(
      needsSharedRoomAgentConsent(true, "ws://127.0.0.1:1234", "ws://127.0.0.1:1234", "solo", false),
      false
    );
    assert.equal(
      needsSharedRoomAgentConsent(true, "wss://relay.example", undefined, "standup", true),
      false
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

describe("streamlined onboarding decisions", () => {
  test("starts with joining and then distinguishes setup from an existing detached agent", () => {
    const beforeJoin = decideOnboarding({ configuredAgents: [] });
    assert.equal(beforeJoin.action.kind, "joinRoom");
    assert.deepEqual(beforeJoin.steps.map((step) => step.status), ["current", "pending", "pending"]);

    const needsSetup = decideOnboarding({
      room: "review",
      role: "member",
      configuredAgents: [],
    });
    assert.equal(needsSetup.action.kind, "addAgent");
    assert.equal(needsSetup.steps[1].label, "Agent needs setup");
    assert.equal(needsSetup.showAgentHelp, true);

    const existing = decideOnboarding({
      room: "review",
      role: "member",
      configuredAgents: [{ id: "local:agent", state: "detached" }],
    });
    assert.equal(existing.action.kind, "attachAgent");
    assert.equal(existing.steps[1].label, "Agent ready");
  });

  test("uses local and relay-authoritative attachment state to finish progress", () => {
    for (const input of [
      {
        configuredAgents: [{ id: "local:agent", state: "attaching" }],
      },
      {
        configuredAgents: [{ id: "local:agent", state: "detached" }],
        attachedAgentIds: ["ivan::local:agent"],
      },
    ]) {
      const decision = decideOnboarding({ room: "review", role: "owner", ...input });
      assert.equal(decision.complete, true);
      assert.equal(decision.action, undefined);
      assert.deepEqual(decision.steps.map((step) => step.status), [
        "complete",
        "complete",
        "complete",
      ]);
    }
  });

  test("viewers get an explicit read-only path and no agent action", () => {
    const decision = decideOnboarding({
      room: "review",
      role: "viewer",
      configuredAgents: [{ id: "local:agent", state: "detached" }],
    });
    assert.equal(decision.readOnly, true);
    assert.equal(decision.action, undefined);
    assert.match(decision.steps[2].label, /read-only/i);
  });
});

describe("fast-path agent defaults", () => {
  test("puts detected providers first without accepting or inventing ids", () => {
    assert.deepEqual(
      orderDetectedProviderIds(["codex", "claude-code", "gemini", "custom"], ["gemini", "unknown"]),
      ["gemini", "codex", "claude-code", "custom"]
    );
  });

  test("uses only concrete safe permission defaults", () => {
    assert.equal(safestUsablePermission("codex", "cli"), "readOnly");
    assert.equal(safestUsablePermission("claude-code", "claude-code"), "workspace");
    assert.equal(safestUsablePermission("gemini", "cli"), undefined);
    assert.equal(safestUsablePermission("grok", "openai-compatible"), undefined);
  });

  test("keeps one normal responder while new agents wait to be named", () => {
    assert.equal(responseModeForNewAgent(0), "automatic");
    assert.equal(responseModeForNewAgent(1), "mentions");
    assert.equal(effectiveResponseMode(undefined, 0), "automatic");
    assert.equal(effectiveResponseMode(undefined, 1), "mentions");
    assert.equal(effectiveResponseMode("mentions", 0), "mentions");
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
