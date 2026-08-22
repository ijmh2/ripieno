const { test } = require("node:test");
const assert = require("node:assert/strict");

const { applyGoalState } = require("../dist/goalState.js");

const goal = (id, version = 1) => ({
  id,
  text: id,
  ownerHandle: "ivan",
  ownerName: "Ivan",
  status: "active",
  version,
  createdAt: 1,
  updatedAt: version,
});

test("goal UI state accepts equal/new revisions and ignores stale frames", () => {
  const oldAudit = [{ goalId: "goal_old", action: "create" }];
  const initial = { goals: [goal("goal_old")], goalAudit: oldAudit, roomRevision: 4 };
  assert.equal(applyGoalState(initial, [goal("goal_stale")], [], 3), initial);

  const equal = applyGoalState(initial, [goal("goal_reconnect")], oldAudit, 4);
  assert.deepEqual(equal, {
    goals: [goal("goal_reconnect")],
    goalAudit: oldAudit,
    roomRevision: 4,
  });

  const newAudit = [{ goalId: "goal_new", action: "pause" }];
  const newer = applyGoalState(equal, [goal("goal_new", 2)], newAudit, 5);
  assert.deepEqual(newer, {
    goals: [goal("goal_new", 2)],
    goalAudit: newAudit,
    roomRevision: 5,
  });
});

