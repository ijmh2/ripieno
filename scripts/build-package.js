#!/usr/bin/env node
// Clean only the dist directory of one known workspace, then invoke TypeScript
// directly. This works in cmd.exe as well as a POSIX shell.
const { execFileSync } = require("node:child_process");
const { existsSync, rmSync } = require("node:fs");
const path = require("node:path");

const packages = path.resolve(__dirname, "../packages");
const workspace = path.resolve(process.cwd());
if (path.dirname(workspace) !== packages || !existsSync(path.join(workspace, "tsconfig.json"))) {
  throw new Error("Run build-package.js from a TypeScript workspace under packages/.");
}
const dist = path.resolve(workspace, "dist");
if (path.dirname(dist) !== workspace) throw new Error("Invalid build output directory.");
rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
  cwd: workspace,
  stdio: "inherit",
});
