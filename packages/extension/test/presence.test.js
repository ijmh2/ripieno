/**
 * The reporting side of presence.
 *
 * The relay enforces the limits, because a host is the thing that may be lying
 * or dead. This is the same discipline applied where the frames are produced,
 * for the ordinary reason that sending frames which will be dropped is waste —
 * plus the two jobs only a host can do: minting the sequence the relay orders
 * by, and keeping a long turn's presence alive while nothing about it changes.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { PresenceStream } = require("../dist/presence.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stream(limits = { minIntervalMs: 60, heartbeatMs: 10_000 }) {
  const sent = [];
  const presence = new PresenceStream((message) => sent.push(message), limits);
  return { presence, sent };
}

describe("presence is reported at a rate the room can use", () => {
  test("a burst becomes one frame now and the newest one after the window", async () => {
    const { presence, sent } = stream();
    for (let i = 1; i <= 20; i += 1) {
      presence.publish({ phase: "reading", summary: `Reading file ${i}`, path: `src/f${i}.ts` });
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].summary, "Reading file 1");
    await wait(120);
    assert.equal(sent.length, 2, "nineteen updates collapse into one");
    assert.equal(sent[1].summary, "Reading file 20", "and it is the newest that survives");
  });

  test("every frame carries the next sequence, and they only go forwards", async () => {
    const { presence, sent } = stream();
    presence.publish({ phase: "thinking", summary: "One" });
    await wait(120);
    presence.publish({ phase: "editing", summary: "Two" });
    await wait(120);
    presence.publish({ phase: "responding", summary: "Three" });
    await wait(120);
    assert.deepEqual(sent.map((frame) => frame.sequence), [1, 2, 3]);
    assert.deepEqual(sent.map((frame) => frame.t), ["agentActivity", "agentActivity", "agentActivity"]);
  });

  test("an unchanged update is not re-sent", async () => {
    const { presence, sent } = stream();
    presence.publish({ phase: "running", summary: "Running a shell command" });
    await wait(120);
    presence.publish({ phase: "running", summary: "Running a shell command" });
    await wait(120);
    assert.equal(sent.length, 1);
  });

  test("a heartbeat keeps a long unchanging turn from expiring", async () => {
    const { presence, sent } = stream({ minIntervalMs: 20, heartbeatMs: 60 });
    presence.publish({ phase: "editing", summary: "Editing src/a.ts", path: "src/a.ts", line: 4 });
    await wait(200);
    assert.ok(sent.length >= 3, `expected repeats, got ${sent.length}`);
    for (const frame of sent) {
      assert.equal(frame.phase, "editing");
      assert.equal(frame.path, "src/a.ts");
    }
    // Each repeat still advances the sequence, so the relay can order them.
    const sequences = sent.map((frame) => frame.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
    presence.dispose();
  });

  test("disposing stops the heartbeat and drops a coalesced frame", async () => {
    const { presence, sent } = stream({ minIntervalMs: 60, heartbeatMs: 40 });
    presence.publish({ phase: "editing", summary: "Editing" });
    presence.publish({ phase: "running", summary: "Running a shell command" });
    presence.dispose();
    const after = sent.length;
    await wait(200);
    assert.equal(sent.length, after, "a detached agent reports nothing further");
  });

  test("fields are bounded and a range is only claimed with a path", async () => {
    const { presence, sent } = stream();
    presence.publish({
      phase: "editing",
      summary: `Editing ${"x".repeat(500)}`,
      path: "y".repeat(900),
      line: 10,
      endLine: 4,
    });
    assert.ok(sent[0].summary.length <= 240);
    assert.ok(sent[0].path.length <= 500);
    assert.equal(sent[0].endLine, undefined, "an end before the start is not a range");

    await wait(120);
    presence.publish({ phase: "editing", summary: "Editing", line: 10, endLine: 20 });
    await wait(120);
    assert.equal(sent.at(-1).line, undefined, "no path means no line");
    assert.equal(sent.at(-1).endLine, undefined);

    await wait(120);
    presence.publish({ phase: "editing", summary: "Editing", path: "src/a.ts", line: 10, endLine: 20 });
    await wait(120);
    assert.equal(sent.at(-1).line, 10);
    assert.equal(sent.at(-1).endLine, 20);
    presence.dispose();
  });

  test("a fractional or negative line is not a location", async () => {
    const { presence, sent } = stream();
    presence.publish({ phase: "reading", summary: "Reading", path: "src/a.ts", line: -3 });
    assert.equal(sent[0].line, undefined);
    await wait(120);
    presence.publish({ phase: "reading", summary: "Reading", path: "src/a.ts", line: 1.5 });
    await wait(120);
    assert.equal(sent.at(-1).line, undefined);
    presence.dispose();
  });
});
