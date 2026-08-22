const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  handoffDeliveryScopeKey,
  providerSessionScopeKey,
} = require("../dist/sessionScope.js");

test("provider sessions are isolated by normalized relay, room and local agent", () => {
  const one = providerSessionScopeKey("ws://LOCALHOST:80/", "room-one", "agent");
  const equivalent = providerSessionScopeKey("ws://localhost/", "room-one", "agent");
  const otherRoom = providerSessionScopeKey("ws://localhost/", "room-two", "agent");
  const otherRelay = providerSessionScopeKey("wss://relay.example/", "room-one", "agent");
  assert.equal(one, equivalent);
  assert.notEqual(one, otherRoom);
  assert.notEqual(one, otherRelay);
  assert.notEqual(one, "agent", "legacy agent-only keys are never a scoped lookup key");
});

test("handoff delivery journals are additionally scoped by delivery id", () => {
  assert.notEqual(
    handoffDeliveryScopeKey("ws://localhost", "one", "agent", "delivery_a"),
    handoffDeliveryScopeKey("ws://localhost", "one", "agent", "delivery_b")
  );
});
