const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { PresenceDecorations, presenceRange } = require("../dist/presenceDecorations.js");

test("provider ranges are 1-based, inclusive and clamped to the document", () => {
  const range = presenceRange(4, 99, 12);
  assert.equal(range.start.line, 3);
  assert.equal(range.end.line, 11);
  assert.equal(presenceRange(undefined, undefined, 12), undefined);
  assert.equal(presenceRange(-2, 3, 12), undefined);
});

test("file invalidation suppresses an old shared range until a newer observation", () => {
  const decorations = new PresenceDecorations(() => undefined);
  const oldPresence = {
    phase: "editing",
    path: "src/room.ts",
    locationScope: "shared",
    line: 4,
    updatedAt: 100,
  };
  decorations.invalidateSharedPath("src/room.ts", 110);
  assert.equal(decorations.isCurrent(oldPresence), false);
  assert.equal(decorations.isCurrent({ ...oldPresence, updatedAt: 111 }), true);
  assert.equal(
    decorations.isCurrent({ ...oldPresence, locationScope: "private" }),
    true,
    "a shared-host invalidation must not suppress an owner's private coordinate"
  );

  decorations.update([
    {
      handle: "mira",
      displayName: "Mira",
      present: true,
      color: 0,
      agents: [
        { id: "old", owner: "mira", label: "Old", activity: oldPresence },
        { id: "new", owner: "mira", label: "New", activity: { ...oldPresence, updatedAt: 120 } },
      ],
    },
  ]);
  assert.equal(
    decorations.isCurrent(oldPresence),
    false,
    "one agent's newer observation cannot revive another agent's stale range"
  );
  decorations.dispose();
});
