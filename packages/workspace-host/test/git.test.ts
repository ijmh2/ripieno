/**
 * Git as the room's source of truth.
 *
 * Two things here would be quietly catastrophic and are therefore tested against
 * real repositories rather than mocks: discarding work that had not been pushed
 * yet, and "resolving" a push conflict by overwriting somebody's repository. The
 * container is meant to be disposable — that is only true if everything it did
 * is safely in history first.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitWorkspace } from "../src/git.js";

const execAsync = promisify(exec);
const MIRA = { label: "Mira's coder", handle: "ijmh2" };

async function seedOrigin(base: string): Promise<string> {
  const origin = path.join(base, "origin.git");
  await mkdir(origin, { recursive: true });
  await execAsync(`git init --bare -b main ${origin}`);
  const seed = path.join(base, "seed");
  await execAsync(`git clone ${origin} ${seed}`);
  await writeFile(path.join(seed, "README.md"), "# seed\n", "utf8");
  await execAsync(
    "git add -A && git -c user.email=t@t -c user.name=t commit -m seed && git push origin main",
    { cwd: seed }
  );
  return origin;
}

describe("the workspace as a repository", () => {
  let base: string;
  let origin: string;
  let root: string;
  let announced: string[];
  let git: GitWorkspace;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-git-"));
    origin = await seedOrigin(base);
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(async () => {
    announced = [];
    root = path.join(base, `wt-${announced.length}-${process.hrtime.bigint()}`);
    git = new GitWorkspace({
      root,
      keyDir: path.join(base, "keys"),
      repo: { owner: "test", name: "seed", branch: "main", url: origin },
      announce: (m) => announced.push(m),
    });
  });

  test("a fresh container clones the repository", async () => {
    const result = await git.ensureClone();
    assert.equal(result.ok, true);
    assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "# seed\n");
  });

  test("a restart keeps uncommitted work instead of re-cloning over it", async () => {
    // The failure this exists for: a container restarting mid-session and
    // silently resetting to origin would destroy work nobody had pushed yet.
    await git.ensureClone();
    await writeFile(path.join(root, "in-progress.txt"), "not committed", "utf8");

    const second = await git.ensureClone();
    assert.equal(second.ok, true);
    assert.match(second.message, /already checked out/);
    assert.equal(await readFile(path.join(root, "in-progress.txt"), "utf8"), "not committed");
  });

  test("a commit is authored by the agent and committed by the workspace", async () => {
    await git.ensureClone();
    await writeFile(path.join(root, "a.txt"), "one", "utf8");
    await git.commit("a.txt", MIRA, "Add a.txt");

    const { stdout } = await execAsync(`git log -1 --format='%an|%ae|%cn'`, { cwd: root });
    const [an, ae, cn] = stdout.trim().split("|");
    assert.equal(an, "Mira's coder");
    assert.equal(ae, "ijmh2+agent@users.noreply.github.com");
    assert.equal(cn, "Shared workspace");
  });

  test("a write that changes nothing produces no commit", async () => {
    await git.ensureClone();
    const before = (await execAsync("git rev-list --count HEAD", { cwd: root })).stdout.trim();
    await git.commit("README.md", MIRA, "no-op");
    const after = (await execAsync("git rev-list --count HEAD", { cwd: root })).stdout.trim();
    assert.equal(after, before, "an empty commit would litter history with nothing");
  });

  test("work reaches the repository", async () => {
    await git.ensureClone();
    await writeFile(path.join(root, "pushed.txt"), "yes", "utf8");
    await git.commit("pushed.txt", MIRA, "Add pushed.txt");
    await git.flush();

    const { stdout } = await execAsync(`git log --format='%s' origin/main -1`, { cwd: root });
    assert.match(stdout, /Add pushed\.txt/);
  });

  test("a rejected push is reported, and nothing is force-pushed", async () => {
    await git.ensureClone();

    // Somebody else pushes in the meantime — the ordinary way this happens.
    const other = path.join(base, `other-${process.hrtime.bigint()}`);
    await execAsync(`git clone ${origin} ${other}`);
    await writeFile(path.join(other, "theirs.txt"), "theirs", "utf8");
    await execAsync(
      "git add -A && git -c user.email=o@o -c user.name=o commit -m theirs && git push origin main",
      { cwd: other }
    );

    await writeFile(path.join(root, "ours.txt"), "ours", "utf8");
    await git.commit("ours.txt", MIRA, "Add ours.txt");
    await git.flush();

    assert.match(announced.join(" "), /Push rejected/);
    assert.match(announced.join(" "), /Nothing has been force-pushed/);

    // The decisive assertion: their commit still exists on the remote.
    const { stdout } = await execAsync(`git log --format='%s' -5 main`, { cwd: origin });
    assert.match(stdout, /theirs/, "their work must survive our failed push");

    // And ours is safe locally, not lost with the failure.
    const local = await execAsync(`git log --format='%s' -1`, { cwd: root });
    assert.match(local.stdout, /Add ours\.txt/);
  });

  test("a repeated failure is announced once, not on every write", async () => {
    await git.ensureClone();
    const other = path.join(base, `other2-${process.hrtime.bigint()}`);
    await execAsync(`git clone ${origin} ${other}`);
    await writeFile(path.join(other, "more.txt"), "m", "utf8");
    await execAsync(
      "git add -A && git -c user.email=o@o -c user.name=o commit -m more && git push origin main",
      { cwd: other }
    );

    for (const name of ["x.txt", "y.txt"]) {
      await writeFile(path.join(root, name), name, "utf8");
      await git.commit(name, MIRA, `Add ${name}`);
      await git.flush();
    }
    const rejections = announced.filter((m) => /Push rejected/.test(m));
    assert.equal(rejections.length, 1, "one explanation, not one per write");
  });

  test("an unbound workspace is a usable scratch directory", async () => {
    const scratch = new GitWorkspace({
      root: path.join(base, "scratch"),
      keyDir: path.join(base, "keys"),
      announce: (m) => announced.push(m),
    });
    const result = await scratch.ensureClone();
    assert.equal(result.ok, true);
    // Committing without a repo must be a no-op, not a crash.
    await scratch.commit("anything.txt", MIRA, "nope");
  });

  test("an interrupted clone is not mistaken for a healthy checkout", async () => {
    // git clone creates the target and .git before the fetch finishes, and
    // cannot tidy up after a SIGKILL. A container killed mid-clone restarted,
    // saw .git, reported "already checked out" and served agents an empty tree —
    // the guard protecting uncommitted work was also blocking recovery.
    const halfDone = path.join(base, `half-${process.hrtime.bigint()}`);
    await mkdir(path.join(halfDone, ".git"), { recursive: true });
    const wounded = new GitWorkspace({
      root: halfDone,
      keyDir: path.join(base, "keys"),
      repo: { owner: "test", name: "seed", branch: "main", url: origin },
      announce: (m) => announced.push(m),
    });

    const result = await wounded.ensureClone();
    assert.equal(result.ok, true, `should have recovered: ${result.message}`);
    assert.ok(!/already checked out/.test(result.message), result.message);
    assert.equal(await readFile(path.join(halfDone, "README.md"), "utf8"), "# seed\n");
  });

  test("a command that changes files is committed and reported", async () => {
    // Writes go through applyWrite, which commits and announces. A command does
    // not: `prettier --write` left the workspace dirty, uncommitted and
    // invisible, so members' caches served stale bytes and the work vanished
    // with the container.
    await git.ensureClone();
    await writeFile(path.join(root, "generated.ts"), "export const x = 1;\n", "utf8");

    const changed = await git.commitAll(MIRA, "Mira's coder ran a command that changed files");
    assert.deepEqual(changed, ["generated.ts"]);

    const { stdout } = await execAsync(`git log -1 --format='%an|%s'`, { cwd: root });
    const [author, subject] = stdout.trim().split("|");
    assert.equal(author, "Mira's coder", "the agent that ran it owns the change");
    assert.match(subject!, /ran a command/);
    assert.equal((await execAsync("git status --porcelain", { cwd: root })).stdout.trim(), "");
  });

  test("a command that changes nothing produces no commit", async () => {
    await git.ensureClone();
    const before = (await execAsync("git rev-list --count HEAD", { cwd: root })).stdout.trim();
    assert.deepEqual(await git.commitAll(MIRA, "nothing happened"), []);
    const after = (await execAsync("git rev-list --count HEAD", { cwd: root })).stdout.trim();
    assert.equal(after, before);
  });

  test("the deploy key is generated once and reused", async () => {
    const first = await git.ensureDeployKey();
    assert.match(first, /^ssh-ed25519 /);
    assert.equal(await git.ensureDeployKey(), first, "regenerating would invalidate the one on the repo");
  });
});
