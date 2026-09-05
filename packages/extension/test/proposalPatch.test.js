const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  boundedProposalPatch,
  replacementProposalPatch,
} = require("../dist/runnerEvents.js");
const { MAX_AGENT_PROPOSAL_PATCH_BYTES } = require("@ripieno/protocol");

test("proposal patches are UTF-8 bounded and visibly marked when truncated", () => {
  const patch = boundedProposalPatch("é".repeat(MAX_AGENT_PROPOSAL_PATCH_BYTES));
  assert.ok(Buffer.byteLength(patch, "utf8") <= MAX_AGENT_PROPOSAL_PATCH_BYTES);
  assert.match(patch, /\[proposal truncated\]$/);
  assert.doesNotMatch(patch, /�/);
});

test("large replacement proposals retain bounded, labelled pieces of both sides", () => {
  const patch = replacementProposalPatch(
    "src/a.ts",
    `old-${"a".repeat(50_000)}`,
    `new-${"b".repeat(50_000)}`
  );
  assert.ok(Buffer.byteLength(patch, "utf8") <= MAX_AGENT_PROPOSAL_PATCH_BYTES);
  assert.match(patch, /-old-/);
  assert.match(patch, /\+new-/);
  assert.match(patch, /\[side truncated\]/);
});
