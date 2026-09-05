const { test } = require("node:test");
const assert = require("node:assert/strict");
const { compactHandoffDelivery, storeHandoffDelivery, MAX_HANDOFF_JOURNAL_RECEIPTS } = require("../dist/handoffJournal.js");

const delivery = (status = "assigned") => ({ handoffId: "handoff-1", deliveryId: "delivery-1", handoffVersion: 3, status, updatedAt: 1, context: { transcript: [{ text: "room context" }] }, detail: "Finished" });

test("pending and started deliveries retain independent continuation data", () => {
  for (const status of ["assigned", "started"]) {
    const original = delivery(status);
    const compacted = compactHandoffDelivery(original);
    assert.deepEqual(compacted, original);
    compacted.context.transcript[0].text = "changed";
    assert.equal(original.context.transcript[0].text, "room context");
  }
});

test("terminal receipts retain dedup identity and outcome without room payloads", () => {
  for (const status of ["completed", "failed", "outcomeUnknown"]) {
    const original = delivery(status);
    const compacted = compactHandoffDelivery(original);
    assert.deepEqual(compacted, { handoffId: original.handoffId, deliveryId: original.deliveryId, handoffVersion: 3, status, updatedAt: 1, detail: "Finished" });
    assert.ok(original.context);
    assert.deepEqual(compactHandoffDelivery(compacted), compacted);
  }
});

test("writes compact old terminal payloads while preserving all receipt keys and active work", () => {
  const journal = { "room-a:done": delivery("completed"), "room-b:active": delivery("started") };
  const next = storeHandoffDelivery(journal, "room-c:new", delivery());
  assert.deepEqual(Object.keys(next), ["room-a:done", "room-b:active", "room-c:new"]);
  assert.equal(next["room-a:done"].context, undefined);
  assert.deepEqual(next["room-b:active"].context, journal["room-b:active"].context);
  assert.ok(journal["room-a:done"].context);
});

test("a full journal refuses new execution receipts without evicting or blocking an existing outcome", () => {
  const journal = Object.fromEntries(Array.from({length: MAX_HANDOFF_JOURNAL_RECEIPTS}, (_, i) => [String(i), delivery("completed")]));
  assert.throws(() => storeHandoffDelivery(journal, "new", delivery()), /receipt store is full/);
  const next = storeHandoffDelivery(journal, "0", delivery("outcomeUnknown"));
  assert.equal(Object.keys(next).length, MAX_HANDOFF_JOURNAL_RECEIPTS);
  assert.equal(next["0"].status, "outcomeUnknown");
  assert.ok(journal["1"].context);
});
