/**
 * The confinement checks, tested directly for the first time.
 *
 * These are the security boundary of the product — the agent's tool input is
 * untrusted text from a relay we don't control — but until this extraction they
 * were private functions inside a module that imports `vscode`, so they could
 * only be exercised through a stub. They were audited and never covered. Now
 * that they are plain Node, they get real tests, and the container inherits
 * them rather than growing a second copy to get wrong.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafePath, confineToWorkspace, isInside } from "../src/paths.js";

describe("a path from an agent cannot leave the workspace", () => {
  let root: string;
  let outside: string;

  before(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "mpa-paths-"));
    root = path.join(base, "workspace");
    outside = path.join(base, "secrets");
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "ok", "utf8");
    await writeFile(path.join(outside, "id_rsa"), "PRIVATE KEY", "utf8");
  });

  after(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  test("an ordinary nested path resolves", async () => {
    const safe = await resolveSafePath(root, "src/a.ts");
    assert.equal(safe.ok, true);
  });

  test("the root itself is inside itself", async () => {
    assert.equal((await resolveSafePath(root, ".")).ok, true);
  });

  test("a .. escape is refused", async () => {
    const safe = await resolveSafePath(root, "../secrets/id_rsa");
    assert.equal(safe.ok, false);
    assert.match((safe as { reason: string }).reason, /outside the workspace/);
  });

  test("a deeply buried .. escape is refused", async () => {
    const safe = await resolveSafePath(root, "src/../../secrets/id_rsa");
    assert.equal(safe.ok, false);
  });

  test("an absolute path is refused", async () => {
    const safe = await resolveSafePath(root, "/etc/passwd");
    assert.equal(safe.ok, false);
  });

  test("a symlink pointing out of the workspace is refused", async () => {
    // The case a syntactic check cannot catch: the path looks entirely innocent
    // and only realpath reveals where it lands.
    await symlink(outside, path.join(root, "vendor"), "dir");
    const safe = await resolveSafePath(root, "vendor/id_rsa");
    assert.equal(safe.ok, false);
    assert.match((safe as { reason: string }).reason, /symlink/);
  });

  test("a path that does not exist yet is allowed, so files can be created", async () => {
    const safe = await resolveSafePath(root, "src/brand-new.ts");
    assert.equal(safe.ok, true);
  });

  test("a not-yet-existing path outside is still refused", async () => {
    assert.equal((await resolveSafePath(root, "../elsewhere/new.ts")).ok, false);
  });
});

describe("confineToWorkspace drops results that only look internal", () => {
  let root: string;
  let outside: string;

  before(async () => {
    const base = await mkdtemp(path.join(tmpdir(), "mpa-confine-"));
    root = path.join(base, "workspace");
    outside = path.join(base, "elsewhere");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(root, "real.ts"), "", "utf8");
    await writeFile(path.join(outside, "leaked.ts"), "", "utf8");
    await symlink(outside, path.join(root, "linked"), "dir");
  });

  after(async () => {
    await rm(path.dirname(root), { recursive: true, force: true });
  });

  test("a file reached through a symlinked directory is dropped", async () => {
    const kept = await confineToWorkspace(
      [path.join(root, "real.ts"), path.join(root, "linked", "leaked.ts")],
      root
    );
    assert.deepEqual(kept, [path.join(root, "real.ts")]);
  });

  test("an unreadable root yields nothing rather than everything", async () => {
    assert.deepEqual(await confineToWorkspace([path.join(root, "real.ts")], "/no/such/root"), []);
  });
});

describe("isInside", () => {
  test("a sibling with a shared prefix is not inside", () => {
    // "/a/workspace-old" must not count as inside "/a/workspace".
    assert.equal(isInside("/a/workspace-old/f.ts", "/a/workspace"), false);
    assert.equal(isInside("/a/workspace/f.ts", "/a/workspace"), true);
  });
});
