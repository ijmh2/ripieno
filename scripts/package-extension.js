#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist");
mkdirSync(output, { recursive: true });
execFileSync(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--out", output], {
  cwd: path.join(root, "packages/extension"),
  stdio: "inherit",
});
