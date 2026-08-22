const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyHandoffState } = require("../dist/handoffState.js");

test("handoff state ignores stale reconnect frames and clones authoritative snapshots", () => {
  const current = { handoffs: [], handoffAudit: [], handoffRevision: 3, other: true };
  assert.equal(applyHandoffState(current, [{ id: "stale" }], [], 2), current);
  const handoffs = [{ id: "fresh", status: "pending" }];
  const audit = [{ id: "audit" }];
  const next = applyHandoffState(current, handoffs, audit, 4);
  assert.notEqual(next, current);
  assert.equal(next.handoffRevision, 4);
  assert.notEqual(next.handoffs, handoffs);
  assert.notEqual(next.handoffAudit, audit);
  assert.equal(next.other, true);
});
