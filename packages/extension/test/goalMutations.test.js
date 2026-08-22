const { test } = require("node:test");
const assert = require("node:assert/strict");

const { GoalMutationQueue } = require("../dist/goalMutations.js");

test("lost acknowledgements resend the same request id after joined", () => {
  const queue = new GoalMutationQueue();
  const mutation = { t: "goalCreate", requestId: "req_lost", text: "Ship it" };
  queue.track("demo", mutation);

  assert.deepEqual(queue.forRoom("other"), []);
  assert.deepEqual(queue.forRoom("demo"), [mutation]);
  assert.equal(queue.forRoom("demo")[0].requestId, "req_lost");
  assert.equal(queue.acknowledge("different"), false);
  assert.deepEqual(queue.forRoom("demo"), [mutation]);
  assert.equal(queue.acknowledge("req_lost"), true);
  assert.deepEqual(queue.forRoom("demo"), []);
});

test("queued messages are cloned and explicit leave clears them", () => {
  const queue = new GoalMutationQueue();
  const mutation = {
    t: "goalTransition",
    requestId: "req_pause",
    goalId: "goal_1",
    action: "pause",
    expectedVersion: 1,
  };
  queue.track("demo", mutation);
  mutation.goalId = "tampered";
  assert.equal(queue.forRoom("demo")[0].goalId, "goal_1");
  queue.clear();
  assert.deepEqual(queue.forRoom("demo"), []);
});

