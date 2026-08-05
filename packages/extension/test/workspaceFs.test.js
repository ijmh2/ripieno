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

describe("a file larger than the 50KB response cap survives the round trip", () => {
  // The corruption this closes: read_file caps its *response* at 50KB of bytes
  // no matter how many lines were asked for, and appends "[truncated — output
  // exceeds 50KB]". Only the paging marker was ever filtered, so for any file
  // over 50KB the editor got the first 50KB plus that notice, presented as the
  // whole file. "Propose change to host" then sent it back — replacing another
  // member's file with a prefix of itself, silently, with the tab showing
  // nothing unusual.
  //
  // Driven through the REAL read_file rather than a hand-written fake, because
  // a fake of the producer is exactly where this bug would hide again.
  const os = require("node:os");
  const nodeFs = require("node:fs");
  const { WorkspaceCore } = require("@mpa/workspace-core");

  /** A WorkspaceFileSystem wired to a real WorkspaceCore over a real directory. */
  function workspaceOver(content, name = "big.ts") {
    const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "mpa-fs-"));
    nodeFs.writeFileSync(path.join(root, name), content, "utf8");
    const core = new WorkspaceCore({
      resolveRoot: () => ({ ok: true, abs: root }),
      gate: { proposeWrite: async () => ({ content: "no", isError: true }) },
    });
    const fs = new WorkspaceFileSystem();
    let calls = 0;
    fs.setRemote(async (tool, input) => {
      calls++;
      return await core.execute(tool, input);
    });
    return { fs, root, calls: () => calls };
  }

  const read = async (fs, name) =>
    Buffer.from(await fs.readFile({ path: `/${name}` })).toString("utf8");

  test("a 200KB file comes back byte-identical, not the first 50KB", async () => {
    // Long lines on purpose: the cap is on bytes, so wide lines reach it while
    // the line count is still modest — a minified bundle, a CSV, a lockfile.
    const content = Array.from({ length: 800 }, (_, i) => `${i}: ${"x".repeat(240)}`).join("\n");
    assert.ok(Buffer.byteLength(content) > 190_000, "the fixture must exceed the cap several times over");

    const { fs, calls } = workspaceOver(content);
    const got = await read(fs, "big.ts");

    assert.equal(got.length, content.length, "length must match exactly");
    assert.equal(got, content, "content must match exactly");
    assert.ok(!got.includes("[truncated"), "no marker may reach the buffer");
    assert.ok(calls() > 1, "it must actually have paged rather than got lucky");
  });

  test("a small file still costs a single round trip", async () => {
    const { fs, calls } = workspaceOver("const a = 1;\nconst b = 2;\n", "small.ts");
    assert.equal(await read(fs, "small.ts"), "const a = 1;\nconst b = 2;\n");
    assert.equal(calls(), 1, "paging must not tax the ordinary case");
  });

  test("exact bytes are preserved across a page boundary, trailing blanks included", async () => {
    // Trailing newlines are the classic silent corruption: an editor that eats
    // one rewrites the file the moment anybody saves. Sized to land just past
    // the cap so the last page is nearly empty — the case where an off-by-one
    // in the resume offset would show.
    const content = `${Array.from({ length: 300 }, (_, i) => `line ${i} ${"y".repeat(200)}`).join("\n")}\n\n\n`;
    assert.ok(Buffer.byteLength(content) > 51_200, "the fixture must cross the cap");
    const { fs } = workspaceOver(content, "edge.ts");
    assert.equal(await read(fs, "edge.ts"), content);
  });

  test("a single line too long to transfer fails loudly instead of silently", async () => {
    // No amount of paging helps, and returning what fits is the original bug.
    const { fs } = workspaceOver("z".repeat(80_000), "oneline.ts");
    await assert.rejects(() => fs.readFile({ path: "/oneline.ts" }), /too long to transfer/);
  });
});
