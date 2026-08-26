const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_COMPOSER_CHARS,
  onboardingCommandFor,
  parseRoomViewMessage,
} = require("../dist/roomViewMessages.js");

describe("room webview message boundary", () => {
  test("accepts only the known message shapes", () => {
    assert.deepEqual(parseRoomViewMessage({ type: "ready" }), { type: "ready" });
    assert.deepEqual(parseRoomViewMessage({ type: "send", text: "  hello  " }), {
      type: "send",
      text: "hello",
    });
    assert.deepEqual(
      parseRoomViewMessage({ type: "approvalVerdict", id: "ap_1", choice: "once" }),
      { type: "approvalVerdict", id: "ap_1", choice: "once" }
    );
    assert.deepEqual(
      parseRoomViewMessage({
        type: "handoffAction",
        action: "retry",
        id: "handoff_1",
        expectedVersion: 7,
        targetAgentId: "sam::reviewer",
      }),
      {
        type: "handoffAction",
        action: "retry",
        id: "handoff_1",
        expectedVersion: 7,
        targetAgentId: "sam::reviewer",
      }
    );
    assert.deepEqual(
      parseRoomViewMessage({ type: "onboardingAction", action: "joinRoom" }),
      { type: "onboardingAction", action: "joinRoom" }
    );
    assert.deepEqual(
      parseRoomViewMessage({ type: "onboardingAction", action: "addAgent" }),
      { type: "onboardingAction", action: "addAgent" }
    );
    assert.deepEqual(
      parseRoomViewMessage({
        type: "contextCreate",
        kind: "decision",
        title: "  Use structured context  ",
        body: "  Keep provenance.  ",
        tags: [" architecture "],
      }),
      {
        type: "contextCreate",
        kind: "decision",
        title: "Use structured context",
        body: "Keep provenance.",
        tags: ["architecture"],
      }
    );
    assert.deepEqual(
      parseRoomViewMessage({
        type: "contextStatus",
        id: "context_1",
        expectedVersion: 2,
        status: "accepted",
      }),
      { type: "contextStatus", id: "context_1", expectedVersion: 2, status: "accepted" }
    );
    assert.deepEqual(
      parseRoomViewMessage({
        type: "handoffAction",
        action: "accept",
        id: "handoff_1",
        expectedVersion: 1,
        targetAgentId: "sam::reviewer",
      }),
      {
        type: "handoffAction",
        action: "accept",
        id: "handoff_1",
        expectedVersion: 1,
        targetAgentId: "sam::reviewer",
      }
    );
    assert.deepEqual(
      parseRoomViewMessage({
        type: "handoffAction",
        action: "decline",
        id: "handoff_1",
        expectedVersion: 1,
      }),
      {
        type: "handoffAction",
        action: "decline",
        id: "handoff_1",
        expectedVersion: 1,
        targetAgentId: undefined,
      }
    );
  });

  test("rejects malformed, unknown and oversized messages", () => {
    for (const value of [
      undefined,
      null,
      [],
      "ready",
      {},
      { type: "unknown" },
      { type: "ready", extra: true },
      Object.create({ type: "ready" }),
      { type: "send", text: "   " },
      { type: "send", text: 7 },
      { type: "send", text: "x".repeat(MAX_COMPOSER_CHARS + 1) },
      { type: "send", text: `${" ".repeat(MAX_COMPOSER_CHARS)}x` },
      { type: "approvalVerdict", id: "", choice: "once" },
      { type: "approvalVerdict", id: "x".repeat(129), choice: "once" },
      { type: "approvalVerdict", id: "ap_1", choice: "ALLOW" },
      { type: "approvalVerdict", id: "ap_1", choice: "once", command: "anything" },
      { type: "handoffAction", action: "runCommand", id: "handoff_1", expectedVersion: 1 },
      { type: "handoffAction", action: "accept", id: "", expectedVersion: 1 },
      { type: "handoffAction", action: "accept", id: "handoff_1", expectedVersion: 0 },
      { type: "handoffAction", action: "accept", id: "handoff_1", expectedVersion: 1.5 },
      { type: "handoffAction", action: "accept", id: "handoff_1", expectedVersion: 1, targetAgentId: "" },
      { type: "handoffAction", action: "decline", id: "handoff_1", expectedVersion: 1, targetAgentId: "sam::reviewer" },
      { type: "handoffAction", action: "cancel", id: "handoff_1", expectedVersion: 1, command: "anything" },
      { type: "contextCreate", kind: "thought", title: "Hidden", body: "", tags: [] },
      { type: "contextCreate", kind: "note", title: "", body: "", tags: [] },
      { type: "contextCreate", kind: "note", title: "x", body: "", tags: new Array(9).fill("tag") },
      { type: "contextStatus", id: "context_1", expectedVersion: 0, status: "accepted" },
      { type: "contextStatus", id: "context_1", expectedVersion: 1, status: "proposed" },
      { type: "contextStatus", id: "context_1", expectedVersion: 1, status: "accepted", body: "smuggled" },
    ]) {
      assert.equal(parseRoomViewMessage(value), undefined, JSON.stringify(value)?.slice(0, 160));
    }
  });

  test("accepts the message limit exactly", () => {
    const text = "x".repeat(MAX_COMPOSER_CHARS);
    assert.deepEqual(parseRoomViewMessage({ type: "send", text }), { type: "send", text });
  });

  test("never accepts a caller-supplied command or arguments", () => {
    assert.equal(
      parseRoomViewMessage({
        type: "onboardingAction",
        action: "joinRoom",
        command: "workbench.action.terminal.sendSequence",
      }),
      undefined
    );
    assert.equal(
      parseRoomViewMessage({ type: "onboardingAction", action: "executeCommand" }),
      undefined
    );
    assert.equal(
      parseRoomViewMessage({ type: "onboardingAction", action: "attachAgent", args: ["other"] }),
      undefined
    );
    assert.equal(
      parseRoomViewMessage({ type: "onboardingAction", action: "addAgent", provider: "codex" }),
      undefined
    );
    assert.equal(
      parseRoomViewMessage({
        type: "handoffAction",
        action: "accept",
        id: "handoff_1",
        expectedVersion: 1,
        command: "workbench.action.terminal.sendSequence",
      }),
      undefined
    );
  });
});

describe("onboarding action authorization", () => {
  test("join is allowed only before a room is joined", () => {
    assert.equal(onboardingCommandFor("joinRoom", {}), "ripieno.joinRoom");
    assert.equal(onboardingCommandFor("joinRoom", { room: "review" }), undefined);
  });

  test("add is allowed only for a joined writable member with no configured agent", () => {
    assert.equal(
      onboardingCommandFor("addAgent", {
        room: "review",
        you: { role: "member", agents: [] },
        localAgents: [],
      }),
      "ripieno.addAgent"
    );
    for (const state of [
      {},
      { room: "review" },
      { room: "review", you: { role: "viewer", agents: [] }, localAgents: [] },
      {
        room: "review",
        you: { role: "member", agents: [] },
        localAgents: [{ id: "local:agent", state: "detached" }],
      },
    ]) {
      assert.equal(onboardingCommandFor("addAgent", state), undefined);
    }
  });

  test("attach is allowed only for a joined writable member with a detached local agent", () => {
    assert.equal(
      onboardingCommandFor("attachAgent", {
        room: "review",
        you: { role: "member", agents: [] },
        localAgents: [{ id: "local:agent", state: "detached" }],
      }),
      "ripieno.attachAgent"
    );
    assert.equal(
      onboardingCommandFor("attachAgent", {
        room: "review",
        you: { role: "owner", agents: [] },
        localAgents: [{ id: "local:agent", state: "error" }],
      }),
      "ripieno.attachAgent"
    );

    for (const state of [
      {},
      { room: "review" },
      {
        room: "review",
        you: { role: "viewer", agents: [] },
        localAgents: [{ id: "local:agent", state: "detached" }],
      },
      {
        room: "review",
        you: { role: "member", agents: [{ id: "ivan::local:agent" }] },
        localAgents: [{ id: "local:agent", state: "idle" }],
      },
      { room: "review", you: { role: "member", agents: [] }, localAgents: [] },
      { room: "review", you: { role: "member" } },
    ]) {
      assert.equal(onboardingCommandFor("attachAgent", state), undefined);
    }
  });
});
