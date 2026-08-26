const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ContextMutationQueue } = require("../dist/contextMutations.js");

test("lost context acknowledgements resend the same request id after joined", () => {
  const queue = new ContextMutationQueue();
  const mutation = {
    t: "contextCreate",
    requestId: "context_req_lost",
    kind: "decision",
    title: "Use relay authority",
    body: "The relay owns the canonical context version.",
    tags: ["architecture"],
  };
  queue.track("demo", mutation);

  assert.deepEqual(queue.forRoom("other"), []);
  assert.deepEqual(queue.forRoom("demo"), [mutation]);
  assert.equal(queue.forRoom("demo")[0].requestId, "context_req_lost");
  assert.equal(queue.acknowledge("different"), false);
  assert.deepEqual(queue.forRoom("demo"), [mutation]);
  assert.equal(queue.acknowledge("context_req_lost"), true);
  assert.deepEqual(queue.forRoom("demo"), []);
});

test("queued context mutations are cloned and explicit leave clears them", () => {
  const queue = new ContextMutationQueue();
  const mutation = {
    t: "contextUpdate",
    requestId: "context_req_update",
    contextId: "ctx_1",
    expectedVersion: 1,
    status: "accepted",
  };
  queue.track("demo", mutation);
  mutation.contextId = "tampered";

  assert.equal(queue.forRoom("demo")[0].contextId, "ctx_1");
  queue.clear();
  assert.deepEqual(queue.forRoom("demo"), []);
});
