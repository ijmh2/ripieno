const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_COMPOSER_CHARS,
  onboardingCommandFor,
  parseRoomViewMessage,
} = require("../dist/roomViewMessages.js");

describe("room webview message boundary", () => {
  test("accepts only the four known message shapes", () => {
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
      parseRoomViewMessage({ type: "onboardingAction", action: "joinRoom" }),
      { type: "onboardingAction", action: "joinRoom" }
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
  });
});

describe("onboarding action authorization", () => {
  test("join is allowed only before a room is joined", () => {
    assert.equal(onboardingCommandFor("joinRoom", {}), "ripieno.joinRoom");
    assert.equal(onboardingCommandFor("joinRoom", { room: "review" }), undefined);
  });

  test("attach is allowed only for a joined writable member with no agent", () => {
    assert.equal(
      onboardingCommandFor("attachAgent", {
        room: "review",
        you: { role: "member", agents: [] },
      }),
      "ripieno.attachAgent"
    );
    assert.equal(
      onboardingCommandFor("attachAgent", {
        room: "review",
        you: { role: "owner", agents: [] },
      }),
      "ripieno.attachAgent"
    );

    for (const state of [
      {},
      { room: "review" },
      { room: "review", you: { role: "viewer", agents: [] } },
      { room: "review", you: { role: "member", agents: [{}] } },
      { room: "review", you: { role: "member" } },
    ]) {
      assert.equal(onboardingCommandFor("attachAgent", state), undefined);
    }
  });
});
