const { test } = require("node:test");
const assert = require("node:assert/strict");

const { DraftStream, takeUtf8Prefix } = require("../dist/draftStream.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("provider token fragments are coalesced into bounded ordered frames", async () => {
  const sent = [];
  const stream = new DraftStream((message) => sent.push(message), {
    minIntervalMs: 20,
    maxFrameBytes: 8,
    maxTurnBytes: 32,
  });
  stream.start();
  for (const piece of ["It", " ", "builds", "."]) stream.publish(piece);
  await wait(30);
  assert.deepEqual(sent, [
    { t: "agentDraft", delta: "It build", sequence: 1 },
  ]);
  await wait(30);
  assert.deepEqual(sent.at(-1), { t: "agentDraft", delta: "s.", sequence: 2 });
  stream.complete();
  stream.dispose();
});

test("cancel withdraws a visible partial but does not send noise for a local-only buffer", async () => {
  const sent = [];
  const buffered = new DraftStream((message) => sent.push(message), {
    minIntervalMs: 10_000,
    maxFrameBytes: 10,
    maxTurnBytes: 20,
  });
  buffered.publish("not sent");
  buffered.cancel();
  assert.deepEqual(sent, []);

  const cancellable = new DraftStream((message) => sent.push(message), {
    minIntervalMs: 1,
    maxFrameBytes: 10,
    maxTurnBytes: 20,
  });
  cancellable.publish("visible");
  await wait(5);
  assert.equal(sent.at(-1).t, "agentDraft");
  cancellable.cancel();
  assert.equal(sent.at(-1).t, "agentDraftCancel");
});

test("UTF-8 bounds keep whole surrogate pairs and cap a turn by bytes", () => {
  assert.equal(takeUtf8Prefix("a😀b", 4), "a");
  assert.equal(takeUtf8Prefix("a😀b", 5), "a😀");

  const sent = [];
  const stream = new DraftStream((message) => sent.push(message), {
    minIntervalMs: 10_000,
    maxFrameBytes: 5,
    maxTurnBytes: 6,
  });
  stream.publish("éééé"); // eight bytes; only six belong to this turn
  stream.complete();
  assert.deepEqual(sent.map((message) => message.delta), ["éé", "é"]);
  assert.equal(sent.every((message) => Buffer.byteLength(message.delta, "utf8") <= 5), true);
});
