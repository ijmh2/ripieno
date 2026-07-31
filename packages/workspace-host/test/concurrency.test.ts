/**
 * Two agents working at the same time — the case the product is named after.
 *
 * The existing tests wrote sequentially and passed while five files in six were
 * being silently dropped. Git serialises on `.git/index.lock`; whoever loses
 * throws, the gate swallowed it into a prose warning, and the file stayed on the
 * container's disk only. Then the container gets redeployed and it is gone —
 * which inverts the argument the whole design rests on. If writes are not
 * committed, the container is not disposable.
 *
 * These tests write concurrently on purpose. They are slow because they use a
 * real repository; that is the point.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { GitWorkspace } from "../src/git.js";
import { ContainerGate } from "../src/gate.js";
import type { WriteProposal } from "@mpa/workspace-core";

const execAsync = promisify(exec);

async function seedRepo(base: string): Promise<{ origin: string; work: string }> {
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
  return { origin, work: path.join(base, "work") };
}

describe("concurrent agents do not lose work", () => {
  let base: string;
  let origin: string;
  let root: string;
  let git: GitWorkspace;
  let gate: ContainerGate;
  let announced: string[];

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-conc-"));
    ({ origin } = await seedRepo(base));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  beforeEach(async () => {
    announced = [];
    root = path.join(base, `w${process.hrtime.bigint()}`);
    git = new GitWorkspace({
      root,
      keyDir: path.join(base, "keys"),
      repo: { owner: "t", name: "seed", branch: "main", url: origin },
      announce: (m) => announced.push(m),
    });
    await git.ensureClone();
    gate = new ContainerGate({
      policy: { allow: [], allowAll: false },
      commit: (p) => git.commit(path.relative(root, p.abs), p.requester, `Add ${path.relative(root, p.abs)}`),
      onChanged: () => {},
      rootFor: () => root,
      commitCommandOutput: (requester) => git.commitAll(requester, "command output"),
      serialise: (fn) => git.exclusive(fn),
    });
  });

  const propose = (rel: string, content: string, label: string): WriteProposal => ({
    rawPath: rel,
    abs: path.join(root, rel),
    proposed: content,
    existed: false,
    requester: { label, handle: label.toLowerCase().replace(/\W+/g, "") },
    report: () => {},
  });

  const log = async (format: string, args = ""): Promise<string[]> =>
    (await execAsync(`git log --format='${format}' ${args}`, { cwd: root })).stdout
      .trim()
      .split("\n")
      .filter(Boolean);

  test("six writes at once produce six commits and lose nothing", async () => {
    // Fire-and-forget is exactly how WorkspaceHost.serve dispatches them.
    const results = await Promise.all(
      [...Array(6)].map((_, i) => gate.applyWrite(propose(`f${i}.txt`, `content ${i}`, `Agent ${i}`)))
    );

    for (const [i, r] of results.entries()) {
      assert.notEqual(r.isError, true, `write ${i} reported an error: ${r.content}`);
      assert.ok(!/could not be committed/.test(r.content), `write ${i}: ${r.content}`);
    }

    const status = (await execAsync("git status --porcelain", { cwd: root })).stdout.trim();
    assert.equal(status, "", `nothing should be left uncommitted, got:\n${status}`);

    const subjects = await log("%s");
    for (let i = 0; i < 6; i++) {
      assert.ok(subjects.includes(`Add f${i}.txt`), `f${i}.txt was never committed`);
    }
  });

  test("each commit keeps the author of the agent that wrote it", async () => {
    // Serialising must not let one agent's commit sweep up another's file — the
    // failure that would look fine and quietly destroy provenance.
    await Promise.all([
      gate.applyWrite(propose("alpha.txt", "a", "Mira's coder")),
      gate.applyWrite(propose("beta.txt", "b", "Sam's reviewer")),
      gate.applyWrite(propose("gamma.txt", "c", "Alex's agent")),
    ]);

    const pairs = await log("%an|%s");
    const authorOf = (file: string) =>
      pairs.find((p) => p.endsWith(`Add ${file}`))?.split("|")[0];
    assert.equal(authorOf("alpha.txt"), "Mira's coder");
    assert.equal(authorOf("beta.txt"), "Sam's reviewer");
    assert.equal(authorOf("gamma.txt"), "Alex's agent");

    // And no commit may carry a file it did not write. `git commit -- <path>`
    // limits itself to that path, but an interleaved `git add` could still stage
    // somebody else's work into the same index — which is how attribution would
    // collapse while every author line still looked correct.
    for (const sha of await log("%H")) {
      const files = (
        await execAsync(`git show --name-only --format= ${sha}`, { cwd: root })
      ).stdout
        .split("\n")
        .filter(Boolean);
      assert.ok(
        files.length <= 1,
        `commit ${sha.slice(0, 7)} swept up another agent's work: ${files.join(", ")}`
      );
    }
  });

  test("two agents writing one path leave that file intact, not spliced", async () => {
    // Both open with O_TRUNC and write at offset 0, so interleaving produced one
    // agent's bytes followed by the tail of the other's — a file neither wrote,
    // committed under one of their names.
    const long = "written by alice".repeat(40) + "\n";
    const short = "written by bob\n";
    await Promise.all([
      gate.applyWrite(propose("shared.txt", long, "Alice")),
      gate.applyWrite(propose("shared.txt", short, "Bob")),
    ]);

    const onDisk = await readFile(path.join(root, "shared.txt"), "utf8");
    assert.ok(
      onDisk === long || onDisk === short,
      `file is a splice of both writes: ${JSON.stringify(onDisk.slice(0, 80))}…`
    );

    // And what git has must match what is on disk.
    const committed = (await execAsync("git show HEAD:shared.txt", { cwd: root })).stdout;
    assert.equal(committed, onDisk, "the commit must contain the bytes that are actually there");
  });

  test("a failed commit is reported as an error, not as prose", async () => {
    // An agent reads `isError`; it may never read the sentence explaining that
    // its work exists on one disk and nowhere else.
    const broken = new ContainerGate({
      policy: { allow: [], allowAll: false },
      commit: async () => {
        throw new Error("index.lock");
      },
      onChanged: () => {},
      rootFor: () => root,
      commitCommandOutput: (requester) => git.commitAll(requester, "command output"),
      serialise: (fn) => fn(),
    });
    const res = await broken.applyWrite(propose("doomed.txt", "x", "Agent"));
    assert.equal(res.isError, true);
    assert.match(res.content, /could not be committed/);
  });
});

describe("a push is never quietly abandoned", () => {
  let base: string;
  let origin: string;
  let root: string;
  let git: GitWorkspace;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-push-"));
    ({ origin } = await seedRepo(base));
    root = path.join(base, "work");
    git = new GitWorkspace({
      root,
      keyDir: path.join(base, "keys"),
      repo: { owner: "t", name: "seed", branch: "main", url: origin },
      announce: () => {},
    });
    await git.ensureClone();
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test("a commit made while a push is in flight still reaches the remote", async () => {
    // push() used to early-return when one was already running and nothing ever
    // re-armed the timer, so the last write of a session could stay local
    // forever with no error anywhere.
    await writeFile(path.join(root, "first.txt"), "1", "utf8");
    await git.commit("first.txt", undefined, "Add first.txt");

    const inFlight = git.push();
    await writeFile(path.join(root, "second.txt"), "2", "utf8");
    await git.commit("second.txt", undefined, "Add second.txt");
    await inFlight;
    await git.flush();

    const remote = (
      await execAsync(`git log --format='%s' origin/main`, { cwd: root })
    ).stdout;
    assert.match(remote, /Add first\.txt/);
    assert.match(remote, /Add second\.txt/, "the commit made during the push must not be stranded");
  });

  test("flush waits for an in-flight push rather than skipping it", async () => {
    await writeFile(path.join(root, "third.txt"), "3", "utf8");
    await git.commit("third.txt", undefined, "Add third.txt");
    const inFlight = git.push();
    await git.flush();
    await inFlight;
    const remote = (await execAsync(`git log --format='%s' origin/main`, { cwd: root })).stdout;
    assert.match(remote, /Add third\.txt/);
  });
});
