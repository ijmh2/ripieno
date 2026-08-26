const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildRoomPanelSnapshot } = require("../dist/roomPanelState.js");

const now = 1_725_000_000_000;

function member(handle, displayName, agents, overrides = {}) {
  return {
    handle,
    displayName,
    role: "member",
    present: true,
    color: handle === "mira" ? 2 : 5,
    agents,
    ...overrides,
  };
}

function input(overrides = {}) {
  const miraAgent = {
    id: "mira::local:coder",
    owner: "mira",
    label: "Mira's coder",
    capability: "workspace",
    state: "editing",
    activity: {
      phase: "editing",
      summary: "Tightening the Room panel",
      path: "packages/extension/src/roomView.ts",
      line: 80,
      endLine: 120,
      updatedAt: now,
      sequence: 4,
    },
  };
  const samAgent = {
    id: "sam::local:coder",
    owner: "sam",
    label: "Sam's coder",
    capability: "conversation",
  };
  const roster = [
    member("mira", "Mira", [miraAgent], { role: "owner" }),
    member("sam", "Sam", [samAgent]),
  ];
  return {
    room: "kitchen",
    mode: "byo",
    you: roster[0],
    roster,
    transcriptCount: 12,
    actions: [
      {
        id: "action_old",
        agentId: miraAgent.id,
        agentLabel: miraAgent.label,
        targetHandle: "mira",
        verb: "read",
        target: "README.md",
        ok: true,
        ts: now - 2_000,
      },
      {
        id: "action_new",
        agentId: miraAgent.id,
        agentLabel: miraAgent.label,
        targetHandle: "mira",
        verb: "wrote",
        target: "packages/extension/src/roomView.ts",
        detail: "+12 −2",
        ok: true,
        ts: now - 1_000,
      },
      {
        id: "action_sam",
        agentId: samAgent.id,
        agentLabel: samAgent.label,
        targetHandle: "sam",
        verb: "searched",
        target: "docs/",
        ok: true,
        ts: now,
      },
    ],
    goals: [
      {
        id: "goal_active",
        text: "Ship Phase 4",
        ownerHandle: "mira",
        ownerName: "Mira",
        status: "active",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "goal_done",
        text: "Ship Phase 3",
        ownerHandle: "mira",
        ownerName: "Mira",
        status: "completed",
        version: 2,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      },
    ],
    contextCount: 3,
    handoffs: [
      {
        id: "handoff_one",
        nonce: "public",
        task: "Review the panel",
        sourceAgentId: miraAgent.id,
        sourceAgentLabel: miraAgent.label,
        sourceOwnerHandle: "mira",
        sourceOwnerName: "Mira",
        targetHandle: "sam",
        targetName: "Sam",
        targetAgentId: samAgent.id,
        targetAgentLabel: samAgent.label,
        status: "started",
        version: 4,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 10_000,
      },
    ],
    usage: [
      {
        agentId: miraAgent.id,
        agentLabel: miraAgent.label,
        owner: "mira",
        provider: "claude-code",
        turns: 3,
        inputTokens: 1_200,
      },
    ],
    localAgents: [
      {
        id: "local:coder",
        label: "Mira's coder",
        state: "editing",
        provider: "claude-code",
        model: "sonnet",
        folder: "ripieno",
        permissions: "Ask before changes",
        responseMode: "automatic",
      },
      {
        // Same local suffix as Sam's exact id must never match a remote owner.
        id: "local:coder",
        label: "Misleading duplicate",
        state: "idle",
        permissions: "Trusted workspace",
      },
    ],
    status: "thinking",
    connection: "online",
    ...overrides,
  };
}

test("panel derives exact-agent work, task, goals, handoffs and usage from authoritative state", () => {
  const panel = buildRoomPanelSnapshot(input());
  assert.equal(panel.type, "panelSnapshot");
  assert.equal(panel.memberCount, 2);
  assert.equal(panel.presentMemberCount, 2);
  assert.equal(panel.actionCount, 3);
  assert.equal(panel.activeGoals.length, 1);
  assert.equal(panel.pendingHandoffCount, 1);

  const mira = panel.agents.find((agent) => agent.agentId === "mira::local:coder");
  assert.equal(mira.ownerName, "Mira");
  assert.equal(mira.currentTask, "Tightening the Room panel");
  assert.equal(mira.statusGroup, "active");
  assert.deepEqual(mira.recentActions.map((entry) => entry.id), ["action_new", "action_old"]);
  assert.deepEqual(mira.workingSet, ["packages/extension/src/roomView.ts", "README.md"]);
  assert.deepEqual(mira.activeGoals.map((goal) => goal.id), ["goal_active"]);
  assert.deepEqual(mira.handoffs.map((handoff) => handoff.id), ["handoff_one"]);
  assert.equal(mira.usage.provider, "claude-code");
});

test("owner-local permissions attach only to the signed-in owner's exact namespaced agent", () => {
  const panel = buildRoomPanelSnapshot(input());
  const mira = panel.agents.find((agent) => agent.agentId === "mira::local:coder");
  const sam = panel.agents.find((agent) => agent.agentId === "sam::local:coder");

  assert.equal(mira.privateLocal.permissions, "Ask before changes");
  assert.equal(mira.privateLocal.provider, "claude-code");
  assert.equal(sam.privateLocal, undefined);
  assert.equal(sam.statusGroup, "unknown");
  assert.equal(sam.currentTask, "Review the panel");
});

test("panel model never treats drafts, transcripts or provider-private fields as diagnostics", () => {
  const state = input({
    drafts: [{ text: "uncommitted answer" }],
    transcript: [{ text: "hidden from inspector" }],
    providerSession: "secret",
  });
  const panel = buildRoomPanelSnapshot(state);
  assert.equal(Object.hasOwn(panel, "drafts"), false);
  assert.equal(Object.hasOwn(panel, "transcript"), false);
  assert.equal(Object.hasOwn(panel, "providerSession"), false);
  assert.equal(JSON.stringify(panel).includes("uncommitted answer"), false);
  assert.equal(JSON.stringify(panel).includes("hidden from inspector"), false);
  assert.equal(JSON.stringify(panel).includes("secret"), false);
});
