/**
 * The parts of the shared-workspace filesystem that hide bugs.
 *
 * The provider itself needs a live VS Code host, but its two pieces of real
 * logic do not: turning `read_file` output back into a file, and deciding what
 * a write invalidates. Both are silent when wrong — a stale read looks like a
 * correct read, and a mangled buffer looks like the file — so they are worth
 * testing directly rather than by eye.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// The provider imports `vscode`, which does not exist outside the editor. Stub
// the handful of members it touches at load time.
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { WorkspaceFileSystem, stripReadFileHeader } = require("../dist/workspaceFs.js");

describe("read_file output becomes a faithful buffer", () => {
  test("the paging header and line numbers are removed", () => {
    const raw = ["src/a.ts — lines 1-3 of 3", "     1\tconst a = 1;", "     2\t", "     3\tconst b = 2;"].join(
      "\n"
    );
    assert.equal(stripReadFileHeader(raw), "const a = 1;\n\nconst b = 2;");
  });

  test("a truncation notice never reaches the buffer", () => {
    const raw = [
      "big.ts — lines 1-2 of 900",
      "     1\tone",
      "     2\ttwo",
      "",
      "[898 more lines — call again with offset: 3]",
    ].join("\n");
    assert.equal(stripReadFileHeader(raw).includes("more lines"), false);
  });

  test("content that merely looks numbered is left alone", () => {
    // No header, so nothing should be stripped — otherwise a file whose lines
    // begin with digits would be quietly corrupted.
    const raw = "1\tfirst\n2\tsecond";
    assert.equal(stripReadFileHeader(raw), raw);
  });

  test("trailing blank lines are preserved exactly", () => {
    // Collapsing these would corrupt a file on every open — silently.
    const raw = ["x.ts — lines 1-3 of 3", "     1\tcode", "     2\t", "     3\t"].join("\n");
    assert.equal(stripReadFileHeader(raw), "code\n\n");
  });

  test("a tab inside real code survives", () => {
    const raw = ["x.ts — lines 1-1 of 1", "     1\tif (a)\tb();"].join("\n");
    assert.equal(stripReadFileHeader(raw), "if (a)\tb();");
  });
});

describe("the action log invalidates exactly what changed", () => {
  function action(verb, target) {
    return {
      id: "a",
      agentId: "s:1",
      agentLabel: "Sam's agent",
      targetHandle: "ijmh2",
      verb,
      target,
      ok: true,
      ts: Date.now(),
    };
  }

  test("a write evicts that file and its directory listing, and nothing else", async () => {
    const fs = new WorkspaceFileSystem();
    const reads = [];
    fs.setRemote(async (name, input) => {
      reads.push(`${name}:${input.path}`);
      return {
        content: name === "list_dir" ? "file\t10\ta.ts" : "src/a.ts — lines 1-1 of 1\n     1\thello",
        isError: false,
      };
    });

    await fs.readFile({ path: "/src/a.ts" });
    await fs.readFile({ path: "/src/b.ts" });
    await fs.readDirectory({ path: "/src" });
    const before = reads.length;

    fs.noteAction(action("wrote", "src/a.ts"));

    // a.ts must be re-fetched; b.ts must still come from cache.
    await fs.readFile({ path: "/src/a.ts" });
    await fs.readFile({ path: "/src/b.ts" });
    assert.equal(reads.length, before + 1, "only the written file should be re-read");
    assert.ok(reads.at(-1).includes("src/a.ts"));

    // The parent listing is refetched too: a write can create a file.
    await fs.readDirectory({ path: "/src" });
    assert.ok(reads.at(-1).startsWith("list_dir"));
  });

  test("a read by another agent invalidates nothing", async () => {
    const fs = new WorkspaceFileSystem();
    const reads = [];
    fs.setRemote(async () => {
      reads.push("read");
      return { content: "x.ts — lines 1-1 of 1\n     1\thello", isError: false };
    });

    await fs.readFile({ path: "/x.ts" });
    fs.noteAction(action("read", "x.ts"));
    await fs.readFile({ path: "/x.ts" });

    assert.equal(reads.length, 1, "a read is not a change and must not evict");
  });

  test("losing the host clears everything, so a new host is never served stale files", async () => {
    const fs = new WorkspaceFileSystem();
    let reads = 0;
    const remote = async () => {
      reads += 1;
      return { content: "x.ts — lines 1-1 of 1\n     1\thello", isError: false };
    };
    fs.setRemote(remote);
    await fs.readFile({ path: "/x.ts" });

    fs.setRemote(undefined);
    fs.setRemote(remote);
    await fs.readFile({ path: "/x.ts" });

    assert.equal(reads, 2);
  });

  test("with no host, reads fail rather than hanging", async () => {
    const fs = new WorkspaceFileSystem();
    await assert.rejects(() => fs.readFile({ path: "/x.ts" }), /nobody in this room is hosting/i);
  });
});
