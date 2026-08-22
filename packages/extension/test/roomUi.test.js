const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../media/main.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../media/main.css"), "utf8");

test("only the signed-in member's human messages use the outgoing side", () => {
  assert.match(
    script,
    /kind === "human" && currentUser\?\.handle === authorHandle/,
    "ownership must use the relay-authenticated handle, not a display-name comparison"
  );
  assert.match(script, /container\.classList\.add\("mine"\)/);
  assert.match(styles, /\.row\.human\.mine\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(styles, /\.row\.human\.mine \.bubble\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(styles, /\.row\.human\.mine \.bubble\s*\{[^}]*border-right:\s*3px/s);
});

