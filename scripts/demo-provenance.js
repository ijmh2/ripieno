#!/usr/bin/env node
/**
 * The one-screen demonstration: two agents belonging to two different people
 * write to the same repository at the same time, and `git log` names each of
 * them correctly.
 *
 * Everyone who has used git knows that author column says one name — whoever's
 * machine ran the commit. Two agent names alternating in it reads instantly as
 * "that should not be possible", which is the whole argument in one screenshot.
 *
 * This runs the real container code (GitWorkspace + ContainerGate) against a
 * real repository in a temp directory, writing concurrently rather than in
 * turn. Nothing here is staged: if provenance broke, this would show it.
 *
 *   npm run build:workspace && node scripts/demo-provenance.js
 *
 * Add --keep to leave the repository behind and print its path, so you can
 * explore it afterwards.
 */

const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { exec } = require("node:child_process");
const { promisify } = require("node:util");
const { tmpdir } = require("node:os");
const path = require("node:path");

const run = promisify(exec);
const root = path.join(__dirname, "..");
const { GitWorkspace } = require(path.join(root, "packages/workspace-host/dist/src/git.js"));
const { ContainerGate } = require(path.join(root, "packages/workspace-host/dist/src/gate.js"));

/** Who writes what. Two people, three agents, one repository. */
const WORK = [
  { agent: "Mira's coder", handle: "ijmh2", file: "src/relay.ts", message: "Add rate limit to relay" },
  { agent: "Sam's reviewer", handle: "swhitfield", file: "test/relay.test.ts", message: "Cover the rate limit" },
  { agent: "Mira's coder", handle: "ijmh2", file: "src/room.ts", message: "Bound the transcript" },
  { agent: "Sam's reviewer", handle: "swhitfield", file: "docs/limits.md", message: "Write down both limits" },
  { agent: "Alex's agent", handle: "alexr", file: "README.md", message: "Mention the limits in the README" },
];

async function seed(base) {
  const origin = path.join(base, "origin.git");
  await mkdir(origin, { recursive: true });
  await run(`git init --bare -b main "${origin}"`);
  const seedDir = path.join(base, "seed");
  await run(`git clone "${origin}" "${seedDir}"`);
  await writeFile(path.join(seedDir, "README.md"), "# demo\n", "utf8");
  await run(
    'git add -A && git -c user.email=demo@example.com -c user.name=demo commit -m "Initial commit" && git push -q origin main',
    { cwd: seedDir }
  );
  return origin;
}

async function main() {
  const keep = process.argv.includes("--keep");
  const base = await mkdtemp(path.join(tmpdir(), "mpa-demo-"));
  const origin = await seed(base);
  const work = path.join(base, "workspace");

  const git = new GitWorkspace({
    root: work,
    keyDir: path.join(base, "keys"),
    repo: { owner: "demo", name: "demo", branch: "main", url: origin },
    announce: () => {},
  });
  await git.ensureClone();

  const subjects = new Map(WORK.map((w) => [w.file, w.message]));
  const gate = new ContainerGate({
    policy: { allow: [], allowAll: false },
    commit: (p) => {
      const rel = path.relative(work, p.abs);
      return git.commit(rel, p.requester, subjects.get(rel) ?? `Update ${rel}`);
    },
    onChanged: () => {},
    rootFor: () => work,
    commitCommandOutput: (requester) => git.commitAll(requester, "command output"),
    serialise: (fn) => git.exclusive(fn),
  });

  console.log(`Three agents, two people, one repository — writing at the same time.\n`);
  for (const w of WORK) {
    console.log(`  ${w.agent.padEnd(16)} writes ${w.file}`);
  }

  // Concurrently, on purpose. Serialised writes would prove nothing: git
  // serialises on .git/index.lock, and losing that race is how five writes in
  // six used to vanish.
  const results = await Promise.all(
    WORK.map((w) =>
      gate.applyWrite({
        rawPath: w.file,
        abs: path.join(work, w.file),
        proposed: `// ${w.message}\n`,
        existed: false,
        requester: { label: w.agent, handle: w.handle },
        report: () => {},
      })
    )
  );
  const failed = results.filter((r) => r.isError || /could not be committed/.test(r.content));
  if (failed.length > 0) {
    console.error(`\n${failed.length} write(s) failed:\n${failed.map((f) => f.content).join("\n")}`);
    process.exitCode = 1;
  }

  // `%<(16)` is git's own column padding, so the alignment in a screenshot is
  // still genuinely git's output and not something this script did to it.
  const FORMAT = "%<(16)%an  %s";
  const log = (await run(`git log --pretty='${FORMAT}' -${WORK.length}`, { cwd: work })).stdout;
  console.log(`\n$ git log --pretty='${FORMAT}' -${WORK.length}\n`);
  console.log(
    log
      .trimEnd()
      .split("\n")
      .map((l) => `  ${l}`)
      .join("\n")
  );

  const dirty = (await run("git status --porcelain", { cwd: work })).stdout.trim();
  console.log(
    `\n${dirty === "" ? "Everything committed" : `UNCOMMITTED:\n${dirty}`} — and the committer is this machine, ` +
      `so each agent authored its own work without being able to claim anyone else's.`
  );

  if (keep) {
    console.log(`\nRepository kept at ${work}`);
  } else {
    await rm(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
