const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  availableRoomWorkspacePath,
  roomWorkspaceName,
  sameWorkspaceRoot,
  workingFolderChoices,
} = require("../dist/workspaceHosting.js");
const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");

test("an empty editor offers only a real folder picker", () => {
  const choices = workingFolderChoices();
  assert.deepEqual(choices.map((choice) => choice.action), ["choose"]);
  assert.equal(choices[0].picked, true);
  assert.doesNotMatch(JSON.stringify(choices), /This workspace/i);
});

test("an open local folder remains the convenient default", () => {
  const choices = workingFolderChoices("ripieno");
  assert.deepEqual(choices.map((choice) => choice.action), ["current", "choose"]);
  assert.equal(choices[0].label, "$(folder) ripieno");
  assert.equal(choices[0].picked, true);
});

test("room workspace names are readable and cannot introduce path segments", () => {
  assert.equal(roomWorkspaceName("Design Review #12"), "design-review-12");
  assert.equal(roomWorkspaceName("../../"), "room");
  assert.equal(roomWorkspaceName("Crème brûlée"), "creme-brulee");
});

test("automatic creation never adopts an existing directory", async () => {
  const parent = path.join(path.sep, "Users", "mira", "Documents", "Ripieno");
  const occupied = new Set([
    path.join(parent, "design-review"),
    path.join(parent, "design-review-2"),
  ]);
  const picked = await availableRoomWorkspacePath(
    parent,
    "Design Review",
    async (candidate) => occupied.has(candidate)
  );
  assert.equal(picked, path.join(parent, "design-review-3"));
});

test("workspace-root comparison normalizes harmless path spelling", () => {
  assert.equal(sameWorkspaceRoot("/work/room/", "/work/room"), true);
  assert.equal(sameWorkspaceRoot("/work/room", "/work/other"), false);
});

test("hosting from an empty window creates or chooses before claiming", () => {
  assert.match(extensionSource, /No folder is open\. Create a workspace for this room\?/);
  assert.match(extensionSource, /"Create and host",\s*"Choose existing folder"/s);
  assert.match(extensionSource, /folder = await attachWorkspaceFolder\(uri\)/);
  assert.match(
    extensionSource,
    /hostingWorkspaceRoot = folder\.uri\.fsPath;\s*relay\.send\(\{ t: "claimWorkspace", claim: true \}\)/s
  );
});

test("closing the exact hosted folder releases the room lease", () => {
  assert.match(extensionSource, /onDidChangeWorkspaceFolders/);
  assert.match(
    extensionSource,
    /if \(hostedWorkspaceFolder\(\)\)[\s\S]*?relay\?\.send\(\{ t: "claimWorkspace", claim: false \}\)/
  );
  assert.match(extensionSource, /shared workspace is offline because its hosted folder was closed/i);
});
