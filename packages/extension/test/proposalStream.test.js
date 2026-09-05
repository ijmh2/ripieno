const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ProposalStream } = require("../dist/proposalStream.js");

test("proposal stream publishes complete shared patches with monotonic ordering", () => {
  const sent = [];
  const stream = new ProposalStream((message) => sent.push(message));
  stream.publish("src/a.ts", "-a\n+b");
  stream.publish("src/b.ts", "-b\n+c");

  assert.deepEqual(sent.slice(0, 2), [
    {
      t: "agentProposal",
      path: "src/a.ts",
      patch: "-a\n+b",
      locationScope: "shared",
      sequence: 1,
    },
    {
      t: "agentProposal",
      path: "src/b.ts",
      patch: "-b\n+c",
      locationScope: "shared",
      sequence: 2,
    },
  ]);
  stream.cancel();
  stream.cancel();
  assert.equal(sent.filter((message) => message.t === "agentProposalCancel").length, 1);
});
