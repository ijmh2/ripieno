const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { runNpm, runCli, onPath } = require("../cli.js");

const root = path.resolve(__dirname, "../..");

test("setup can invoke the installed npm without a shell", () => {
  assert.match(runNpm(["--version"], { encoding: "utf8" }).trim(), /^\d+\.\d+\.\d+/);
});

test("the test runner preserves paths with spaces and propagates failures", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ripieno tests "));
  try {
    const file = path.join(fixture, "space in name.test.js");
    writeFileSync(file, 'require("node:test")("passing", () => {});\n');
    const env = { ...process.env };
    // This is a separate test-runner invocation, not a worker of our runner.
    delete env.NODE_TEST_CONTEXT;
    const run = () => spawnSync(process.execPath, [path.join(root, "scripts/test-files.js"), fixture], { encoding: "utf8", env });
    assert.equal(run().status, 0);
    writeFileSync(file, 'require("node:test")("failing", () => { throw new Error("expected failure"); });\n');
    assert.equal(run().status, 1);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("the build cleaner refuses to delete an unrelated dist directory", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ripieno clean "));
  const sentinel = path.join(fixture, "dist", "keep.txt");
  try {
    mkdirSync(path.dirname(sentinel));
    writeFileSync(sentinel, "keep");
    const result = spawnSync(process.execPath, [path.join(root, "scripts/build-package.js")], {
      cwd: fixture, encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(sentinel, "utf8"), "keep");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("Windows editor shims preserve spaced paths and arguments", { skip: process.platform !== "win32" }, () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "ripieno editor "));
  try {
    const shim = path.join(fixture, "test-editor.cmd");
    const js = path.join(fixture, "args.js");
    writeFileSync(js, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${js}" %*\r\n`);
    const args = ["--install-extension", path.join(fixture, "my preview.vsix"), "--force"];
    assert.deepEqual(JSON.parse(runCli(shim, args, { encoding: "utf8" })), args);
    assert.throws(() => runCli(shim, ["preview%PATH%.vsix"]), /shell expansion characters/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("PATH resolution returns an executable path rather than a shell expression", () => {
  const candidate = onPath("node");
  assert.ok(candidate);
  assert.equal(path.isAbsolute(candidate), true);
});
