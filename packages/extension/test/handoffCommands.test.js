const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  displayHandoffId,
  parseHandoffCommand,
  resolveHandoffAgent,
  resolveHandoffReference,
} = require("../dist/handoffCommands.js");

describe("/handoff parser", () => {
  test("parses all supported commands without treating them as room chat", () => {
    assert.deepEqual(parseHandoffCommand("/handoff offer @sam Mira's coder -- Review the release"), {
      kind: "offer",
      targetHandle: "sam",
      sourceReference: "Mira's coder",
      task: "Review the release",
    });
    assert.deepEqual(parseHandoffCommand("/handoff list"), { kind: "list" });
    assert.deepEqual(parseHandoffCommand("/handoff accept abc123 Sam's reviewer"), {
      kind: "decision",
      action: "accept",
      reference: "abc123",
      targetReference: "Sam's reviewer",
    });
    assert.deepEqual(parseHandoffCommand("/handoff retry abc123 Sam's reviewer"), {
      kind: "decision",
      action: "retry",
      reference: "abc123",
      targetReference: "Sam's reviewer",
    });
    assert.deepEqual(parseHandoffCommand("/handoff decline abc123"), {
      kind: "decision",
      action: "decline",
      reference: "abc123",
    });
    assert.deepEqual(parseHandoffCommand("/handoff cancel abc123"), {
      kind: "decision",
      action: "cancel",
      reference: "abc123",
    });
  });

  test("rejects malformed handoff commands with actionable usage", () => {
    assert.equal(parseHandoffCommand("ordinary chat"), undefined);
    assert.equal(parseHandoffCommand("/handoffs list"), undefined);
    assert.match(parseHandoffCommand("/handoff").message, /Usage:/);
    assert.match(parseHandoffCommand("/handoff offer sam").message, /@member/);
    assert.match(parseHandoffCommand("/handoff offer @sam").message, /-- <task>/);
    assert.match(parseHandoffCommand("/handoff accept").message, /accept <id>/);
    assert.match(parseHandoffCommand("/handoff cancel one two").message, /cancel <id>/);
  });

  test("resolves concise offer ids and only present roster agents", () => {
    const offers = [
      { id: "handoff_12345678-aaaa", status: "pending" },
      { id: "handoff_87654321-bbbb", status: "assigned" },
    ];
    assert.equal(displayHandoffId(offers[0].id), "12345678");
    assert.equal(resolveHandoffReference("12345678", offers).handoff.id, offers[0].id);
    assert.match(resolveHandoffReference("missing", offers).message, /No handoff/);

    const agents = [
      { id: "mira::coder", owner: "mira", label: "Mira's coder" },
      { id: "mira::reviewer", owner: "mira", label: "Mira's reviewer" },
    ];
    assert.equal(resolveHandoffAgent("coder", agents, "source").agent.id, "mira::coder");
    assert.equal(
      resolveHandoffAgent("Mira's reviewer", agents, "target").agent.id,
      "mira::reviewer"
    );
    assert.match(resolveHandoffAgent(undefined, agents, "target").message, /Choose/);
    assert.match(resolveHandoffAgent("missing", agents, "source").message, /No present/);
  });
});
