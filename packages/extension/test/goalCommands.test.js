const { describe, test } = require("node:test");
const assert = require("node:assert/strict");

const {
  displayGoalId,
  parseGoalCommand,
  resolveGoalReference,
} = require("../dist/goalCommands.js");

const goals = [
  {
    id: "goal_12345678-aaaa-bbbb-cccc-000000000000",
    text: "Ship the demo",
    ownerHandle: "ivan",
    ownerName: "Ivan",
    status: "active",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "goal_87654321-aaaa-bbbb-cccc-000000000000",
    text: "Write the launch post",
    ownerHandle: "sam",
    ownerName: "Sam",
    status: "paused",
    version: 2,
    createdAt: 1,
    updatedAt: 2,
  },
];

describe("/goal parser", () => {
  test("parses every supported command without turning it into chat", () => {
    assert.deepEqual(parseGoalCommand("/goal create   Ship the demo "), {
      kind: "create",
      text: "Ship the demo",
    });
    assert.deepEqual(parseGoalCommand("/goal list"), { kind: "list" });
    assert.deepEqual(parseGoalCommand("/goal show 12345678"), {
      kind: "show",
      reference: "12345678",
    });
    for (const action of ["pause", "resume", "complete"]) {
      assert.deepEqual(parseGoalCommand(`/goal ${action} 12345678`), {
        kind: "transition",
        action,
        reference: "12345678",
      });
    }
  });

  test("returns undefined for ordinary messages and actionable errors for malformed goal commands", () => {
    assert.equal(parseGoalCommand("ship it"), undefined);
    assert.equal(parseGoalCommand("/goals list"), undefined);
    assert.match(parseGoalCommand("/goal").message, /Usage:/);
    assert.match(parseGoalCommand("/goal create").message, /create <text>/);
    assert.match(parseGoalCommand("/goal pause one two").message, /pause <id>/);
    assert.match(parseGoalCommand(`/goal create ${"x".repeat(1001)}`).message, /at most 1000/);
  });

  test("resolves opaque ids through concise unambiguous prefixes", () => {
    assert.equal(displayGoalId(goals[0].id), "12345678");
    assert.equal(resolveGoalReference("12345678", goals).goal.id, goals[0].id);
    assert.equal(resolveGoalReference(goals[1].id, goals).goal.id, goals[1].id);
    assert.match(resolveGoalReference("missing", goals).message, /No goal/);
  });
});

