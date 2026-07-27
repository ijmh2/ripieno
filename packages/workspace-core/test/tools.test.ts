/**
 * The tools, against a real directory.
 *
 * The most important test here is the read_file round trip. Its output format is
 * a contract with `stripReadFileHeader` in the extension, which turns the string
 * back into file bytes for the shared-workspace editor. That parser has already
 * been broken once — it collapsed trailing newlines and silently corrupted every
 * file opened from another member's machine — so the format is pinned rather
 * than trusted.
 */

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  WorkspaceCore,
  commandEnv,
  type ApprovalGate,
  type ToolResult,
  type WriteProposal,
} from "../src/index.js";

/** Applies writes without asking, as a container does. */
class AutoGate implements ApprovalGate {
  commandsSeen: string[] = [];
  allow = true;

  async approveCommand(command: string): Promise<boolean> {
    this.commandsSeen.push(command);
    return this.allow;
  }

  async applyWrite(p: WriteProposal): Promise<ToolResult> {
    await writeFile(p.abs, p.proposed, "utf8");
    return { content: `${p.existed ? "Updated" : "Created"} ${p.rawPath}.` };
  }
}

describe("the tools", () => {
  let root: string;
  let gate: AutoGate;
  let core: WorkspaceCore;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "mpa-tools-"));
    await mkdir(path.join(root, "src"), { recursive: true });
    await mkdir(path.join(root, "node_modules", "junk"), { recursive: true });
    await writeFile(path.join(root, "src", "a.ts"), "one\ntwo\nthree\n", "utf8");
    await writeFile(path.join(root, "src", "b.js"), "const needle = 1;\n", "utf8");
    await writeFile(path.join(root, "README.md"), "# hi\n", "utf8");
    await writeFile(path.join(root, "node_modules", "junk", "x.ts"), "noise", "utf8");
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    gate = new AutoGate();
    core = new WorkspaceCore({ resolveRoot: () => ({ ok: true, abs: root }), gate });
  });

  const run = async (name: string, input: Record<string, unknown> = {}) =>
    (await core.execute(name, input))!;

  /* ---------------- read_file: the format contract ---------------- */

  test("read_file emits the exact format stripReadFileHeader parses", async () => {
    const res = await run("read_file", { path: "src/a.ts" });
    const lines = res.content.split("\n");
    assert.equal(lines[0], "src/a.ts — lines 1-4 of 4");
    assert.equal(lines[1], `${"1".padStart(6)}\tone`);
    assert.equal(lines[2], `${"2".padStart(6)}\ttwo`);
  });

  test("a file's bytes survive the round trip, trailing newline included", async () => {
    // The bug this pins: a file ending in a newline came back without one, so
    // every save through the shared workspace quietly changed the file.
    const original = await readFile(path.join(root, "src", "a.ts"), "utf8");
    const res = await run("read_file", { path: "src/a.ts" });
    assert.equal(strip(res.content), original);
  });

  test("a file ending in several blank lines keeps all of them", async () => {
    await writeFile(path.join(root, "blank.txt"), "a\n\n\n", "utf8");
    const res = await run("read_file", { path: "blank.txt" });
    assert.equal(strip(res.content), "a\n\n\n");
  });

  test("a range reports the total and how to get the rest", async () => {
    const res = await run("read_file", { path: "src/a.ts", offset: 2, limit: 1 });
    assert.match(res.content, /^src\/a\.ts — lines 2-2 of 4\n/);
    assert.match(res.content, /call again with offset: 3/);
  });

  test("reading outside the workspace is an error, not a file", async () => {
    const res = await run("read_file", { path: "../../etc/passwd" });
    assert.equal(res.isError, true);
  });

  /* ---------------- listing and searching ---------------- */

  test("list_files finds files at the root and nested, and skips node_modules", async () => {
    const res = await run("list_files", {});
    const found = res.content.split("\n");
    assert.ok(found.includes("README.md"), "root-level files must match **/*");
    assert.ok(found.includes(path.join("src", "a.ts")));
    assert.ok(!res.content.includes("junk"), "node_modules must be pruned");
  });

  test("list_files honours a glob", async () => {
    const res = await run("list_files", { glob: "**/*.ts" });
    assert.ok(res.content.includes("a.ts"));
    assert.ok(!res.content.includes("b.js"));
  });

  test("list_dir distinguishes files from directories", async () => {
    const res = await run("list_dir", { path: "." });
    const rows = res.content.split("\n").map((r) => r.split("\t"));
    const byName = new Map(rows.map((r) => [r[2], r[0]]));
    assert.equal(byName.get("src"), "dir");
    assert.equal(byName.get("README.md"), "file");
    assert.equal(byName.has("node_modules"), false);
  });

  test("stat reports kind and size", async () => {
    const res = await run("stat", { path: "README.md" });
    const [kind, size] = res.content.split("\t");
    assert.equal(kind, "file");
    assert.equal(Number(size), 5);
  });

  test("search finds a match with file and line", async () => {
    const res = await run("search", { query: "needle" });
    assert.match(res.content, /b\.js:1: const needle = 1;/);
  });

  test("search reports nothing found rather than erroring", async () => {
    const res = await run("search", { query: "zzz-not-here" });
    assert.equal(res.content, "No matches.");
    assert.notEqual(res.isError, true);
  });

  /* ---------------- writing ---------------- */

  test("write_file goes through the gate rather than writing directly", async () => {
    const res = await run("write_file", { path: "new.txt", content: "hello" });
    assert.equal(res.content, "Created new.txt.");
    assert.equal(await readFile(path.join(root, "new.txt"), "utf8"), "hello");
  });

  test("a write that changes nothing is not sent to the gate at all", async () => {
    await writeFile(path.join(root, "same.txt"), "identical", "utf8");
    const res = await run("write_file", { path: "same.txt", content: "identical" });
    assert.match(res.content, /nothing to change/);
  });

  test("edit_file refuses an ambiguous match instead of guessing", async () => {
    await writeFile(path.join(root, "twice.txt"), "x\nx\n", "utf8");
    const res = await run("edit_file", { path: "twice.txt", old_text: "x", new_text: "y" });
    assert.equal(res.isError, true);
    assert.match(res.content, /appears 2 times/);
    assert.equal(await readFile(path.join(root, "twice.txt"), "utf8"), "x\nx\n");
  });

  test("edit_file replaces a unique match", async () => {
    await writeFile(path.join(root, "once.txt"), "keep\nchangeme\n", "utf8");
    await run("edit_file", { path: "once.txt", old_text: "changeme", new_text: "changed" });
    assert.equal(await readFile(path.join(root, "once.txt"), "utf8"), "keep\nchanged\n");
  });

  test("writing outside the workspace is refused before the gate sees it", async () => {
    const res = await run("write_file", { path: "../escape.txt", content: "x" });
    assert.equal(res.isError, true);
  });

  /* ---------------- commands ---------------- */

  test("a declined command does not run", async () => {
    gate.allow = false;
    const res = await run("run_command", { command: "echo should-not-happen" });
    assert.equal(res.isError, true);
    assert.match(res.content, /declined/);
  });

  test("an approved command runs in the workspace", async () => {
    const res = await run("run_command", { command: "pwd" });
    assert.ok(res.content.includes(path.basename(root)));
  });

  /* ---------------- dispatch ---------------- */

  test("an unowned tool is handed back, not answered wrongly", async () => {
    // editor_context and diagnostics belong to the editor host; the core must
    // decline them rather than inventing an answer a container cannot give.
    assert.equal(await core.execute("editor_context", {}), undefined);
    assert.equal(WorkspaceCore.handles("diagnostics"), false);
    assert.equal(WorkspaceCore.handles("read_file"), true);
  });

  test("a missing workspace is reported once, by every tool", async () => {
    const rootless = new WorkspaceCore({
      resolveRoot: () => ({ ok: false, reason: "No workspace folder is open." }),
      gate,
    });
    for (const name of ["list_files", "search", "git_status", "read_file"]) {
      const res = await rootless.execute(name, { path: "a", query: "a", command: "a" });
      assert.equal(res?.isError, true, `${name} should refuse without a root`);
    }
  });
});

describe("git authorship follows the acting agent", () => {
  test("a requester sets the author but never the committer", () => {
    const env = commandEnv({ label: "Mira's reviewer", handle: "ijmh2" });
    assert.equal(env.GIT_AUTHOR_NAME, "Mira's reviewer");
    assert.equal(env.GIT_AUTHOR_EMAIL, "ijmh2+agent@users.noreply.github.com");
    assert.equal(env.GIT_COMMITTER_NAME, undefined);
  });

  test("no requester means the ambient environment, untouched", () => {
    assert.equal(commandEnv(), process.env);
  });
});

/** The extension's stripReadFileHeader, duplicated here to pin the contract. */
function strip(result: string): string {
  const lines = result.split("\n");
  if (!/ — lines \d+-\d+ of \d+$/.test(lines[0] ?? "")) return result;
  return lines
    .slice(1)
    .filter((line) => !/^\[\d+ more lines/.test(line))
    .map((line) => line.replace(/^\s*\d+\t/, ""))
    .join("\n");
}
