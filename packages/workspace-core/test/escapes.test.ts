/**
 * The escapes the first round of tests missed.
 *
 * Each of these was found by an audit, not by the suite, and each had a comment
 * next to it asserting the property that turned out to be false. That is worse
 * than no comment: it stops the next reader looking. The tests are written from
 * the exploit, so they fail against the old code for the right reason.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafePath, confineToWorkspace } from "../src/paths.js";
import { globToRegExp } from "../src/walk.js";
import { WorkspaceCore, type ApprovalGate, type ToolResult, type WriteProposal } from "../src/index.js";

class RecordingGate implements ApprovalGate {
  applied: string[] = [];
  async approveCommand(): Promise<boolean> {
    return false;
  }
  async applyWrite(p: WriteProposal): Promise<ToolResult> {
    // Deliberately does NOT write: if confinement fails, the test should say so
    // rather than actually scribbling outside a temp directory.
    this.applied.push(p.abs);
    return { content: "applied" };
  }
}

describe("a symlinked directory cannot be used to write outside the workspace", () => {
  let base: string;
  let root: string;
  let outside: string;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-escape-"));
    root = path.join(base, "workspace");
    outside = path.join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "existing"), "secret", "utf8");
    // The shape a repository can carry in git: a committed symlink to /.
    await symlink(outside, path.join(root, "vendor"), "dir");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("an existing file behind the link is refused", async () => {
    assert.equal((await resolveSafePath(root, "vendor/existing")).ok, false);
  });

  test("a file that does not exist yet behind the link is refused too", async () => {
    // The hole: realpath throws ENOENT for a path whose final component is
    // missing, and the catch assumed the syntactic check had already ruled out
    // escape. It had not — that check ran on the unresolved path, so any
    // symlinked *parent* went unnoticed and the write landed outside.
    const safe = await resolveSafePath(root, "vendor/authorized_keys");
    assert.equal(safe.ok, false, "creating a new file through a symlink must be refused");
  });

  test("nested new directories behind the link are refused", async () => {
    assert.equal((await resolveSafePath(root, "vendor/deep/nested/file")).ok, false);
  });

  test("write_file cannot create a file outside the workspace", async () => {
    const gate = new RecordingGate();
    const core = new WorkspaceCore({ resolveRoot: () => ({ ok: true, abs: root }), gate });
    const res = await core.execute("write_file", {
      path: "vendor/authorized_keys",
      content: "ssh-ed25519 AAAA...",
    });
    assert.equal(res?.isError, true);
    assert.deepEqual(gate.applied, [], "the gate must never be handed a path outside the root");
  });

  test("a genuine new file inside the workspace still works", async () => {
    // The fix must not make creating files impossible, which is the easy
    // over-correction here.
    assert.equal((await resolveSafePath(root, "src/brand-new.ts")).ok, true);
    assert.equal((await resolveSafePath(root, "top-level-new.txt")).ok, true);
  });
});

describe("a symlinked file cannot be read out of the workspace by search", () => {
  let base: string;
  let root: string;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-leak-"));
    root = path.join(base, "workspace");
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(base, "id_rsa"), "AWS_SECRET_ACCESS_KEY=hunter2\n", "utf8");
    await writeFile(path.join(root, "real.txt"), "ordinary content\n", "utf8");
    // Directly in the root, so its *parent* realpaths inside — which is all the
    // old check looked at.
    await symlink(path.join(base, "id_rsa"), path.join(root, "leak.env"));
    await symlink(path.join(base, "id_rsa"), path.join(root, "src", "nested-leak.env"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("confineToWorkspace drops a file symlink pointing outside", async () => {
    const kept = await confineToWorkspace(
      [path.join(root, "real.txt"), path.join(root, "leak.env")],
      root
    );
    assert.deepEqual(kept, [path.join(root, "real.txt")]);
  });

  test("search does not return content from outside the workspace", async () => {
    // read_file already refused this exact path. search printed it — and the
    // inconsistency between the two is what proves the boundary was wrong.
    const core = new WorkspaceCore({
      resolveRoot: () => ({ ok: true, abs: root }),
      gate: new RecordingGate(),
    });
    const res = await core.execute("search", { query: "AWS_SECRET" });
    assert.ok(!res!.content.includes("hunter2"), `leaked: ${res!.content}`);
    assert.ok(!res!.content.includes("AWS_SECRET_ACCESS_KEY"), "not even the matching line");
  });

  test("list_files does not name files that resolve outside", async () => {
    const core = new WorkspaceCore({
      resolveRoot: () => ({ ok: true, abs: root }),
      gate: new RecordingGate(),
    });
    const res = await core.execute("list_files", {});
    assert.ok(res!.content.includes("real.txt"), "ordinary files must still be listed");
    assert.ok(!res!.content.includes("leak.env"), "an escaping symlink must not be listed");
  });
});

describe("a pathological glob cannot pin the event loop", () => {
  // Nested quantifiers: `**/` compiled to (?:[^/]*/)* and bare `**` to .*, and
  // both stacked. Nineteen characters bought 5.9 seconds — per file, against up
  // to 2000 files, on the single thread that also serves the heartbeat.
  const NASTY = [
    "**".repeat(12) + "Z",
    "**/".repeat(12) + "Z",
    "*".repeat(40) + "Z",
    "**/**/**/**/**/**/**/**/**/**/x",
  ];
  const VICTIM = "packages/workspace-core/src/index.ts";

  for (const glob of NASTY) {
    test(`"${glob.slice(0, 24)}…" (${glob.length} chars) matches in bounded time`, () => {
      const re = globToRegExp(glob);
      const started = process.hrtime.bigint();
      re.test(VICTIM);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 100, `took ${ms.toFixed(0)}ms — catastrophic backtracking`);
    });
  }

  test("collapsing does not change what ordinary globs mean", () => {
    assert.equal(globToRegExp("**/*.ts").test("src/a.ts"), true);
    assert.equal(globToRegExp("**/*.ts").test("a.ts"), true, "**/ spans zero segments");
    assert.equal(globToRegExp("**/*.ts").test("src/a.js"), false);
    assert.equal(globToRegExp("src/**").test("src/deep/a.ts"), true);
    assert.equal(globToRegExp("src/**").test("other/a.ts"), false);
    assert.equal(globToRegExp("*.md").test("README.md"), true);
    assert.equal(globToRegExp("*.md").test("docs/README.md"), false, "* stays within a segment");
    assert.equal(globToRegExp("{a,b}.ts").test("b.ts"), true);
  });
});
