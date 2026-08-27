const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { presenceLocationScope, resolvePresencePath } = require("../dist/presenceLocationPolicy.js");

const base = {
  hasSharedWorkspace: false,
  ownsSharedWorkspace: false,
  agentRoot: "/work/agent",
  editorRoot: "/work/shared",
  sharePrivateLocation: false,
};

test("only a real shared coordinate system produces shared presence", () => {
  assert.equal(
    presenceLocationScope({ ...base, hint: "shared", hasSharedWorkspace: true }),
    "shared",
    "the bundled shared-workspace tool is already rooted at the host"
  );
  assert.equal(
    presenceLocationScope({
      ...base,
      ownsSharedWorkspace: true,
      hasSharedWorkspace: true,
      agentRoot: "/work/shared",
    }),
    "shared",
    "a native provider is shared only when its root exactly matches the hosted root"
  );
  assert.equal(
    presenceLocationScope({ ...base, ownsSharedWorkspace: true, hasSharedWorkspace: true }),
    undefined,
    "a similarly shaped independent directory is not treated as shared"
  );
});

test("private locations require the owner-side opt-in", () => {
  assert.equal(presenceLocationScope(base), undefined);
  assert.equal(presenceLocationScope({ ...base, sharePrivateLocation: true }), "private");
});

test("presence paths resolve inside their declared root and nowhere else", () => {
  assert.equal(
    resolvePresencePath("/work/shared", "src/room.ts"),
    path.resolve("/work/shared/src/room.ts")
  );
  assert.equal(resolvePresencePath("/work/shared", "../secret.txt"), undefined);
  assert.equal(resolvePresencePath("/work/shared", "/etc/passwd"), undefined);
  assert.equal(resolvePresencePath("/work/shared", "."), undefined);
});
