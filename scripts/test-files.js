#!/usr/bin/env node
// Node 18/20 and cmd.exe do not expand test/*.test.js consistently. Pass every
// test path as its own argument, preserving spaces and the child exit status.
const { spawnSync } = require("node:child_process");
const { readdirSync } = require("node:fs");
const path = require("node:path");

const directory = path.resolve(process.argv[2] || "test");
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => path.join(directory, entry.name))
  .sort();
if (files.length === 0) throw new Error(`No test files found in ${directory}.`);
const child = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (child.error) throw child.error;
process.exit(child.status ?? 1);
