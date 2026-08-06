#!/usr/bin/env node
/**
 * One command from a fresh clone to an installed extension.
 *
 *   npm run setup
 *
 * The old path was: npm ci, npm run package, then find the .vsix in dist/, then
 * Extensions → … → Install from VSIX, then navigate a file picker. Four commands
 * and a GUI hunt, of which an agent asked to "set this up" could do the first
 * four and then stop. This does everything that can be automated and prints
 * exactly what is left, which on a normal machine is two clicks.
 *
 * Editor CLIs are usually not on PATH — on macOS `code` only appears after the
 * user runs "Shell Command: Install 'code' command in PATH", which most people
 * never do. So this looks inside the installed application bundles too, which is
 * where the same executable has been all along.
 */

const { execFileSync, execSync } = require("node:child_process");
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const root = path.join(__dirname, "..");
const step = (n, text) => console.log(`\n\x1b[1m[${n}]\x1b[0m ${text}`);
const ok = (text) => console.log(`    \x1b[32m✓\x1b[0m ${text}`);
const warn = (text) => console.log(`    \x1b[33m!\x1b[0m ${text}`);

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

/**
 * Every editor that can install a VSIX, in the order we would prefer them.
 *
 * `bin` is the name on PATH; `app` is where macOS keeps the same executable
 * when the user has not installed the shell command. Forks are included because
 * this extension runs in them and their users are exactly the people likely to
 * try it.
 */
const EDITORS = [
  { name: "VS Code", bin: "code", app: "Visual Studio Code.app", cli: "code" },
  { name: "VS Code Insiders", bin: "code-insiders", app: "Visual Studio Code - Insiders.app", cli: "code-insiders" },
  { name: "Cursor", bin: "cursor", app: "Cursor.app", cli: "cursor" },
  { name: "Windsurf", bin: "windsurf", app: "Windsurf.app", cli: "windsurf" },
  { name: "Antigravity", bin: "antigravity-ide", app: "Antigravity IDE.app", cli: "antigravity-ide" },
  { name: "VSCodium", bin: "codium", app: "VSCodium.app", cli: "codium" },
  { name: "Positron", bin: "positron", app: "Positron.app", cli: "positron" },
];

function onPath(bin) {
  try {
    execSync(process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`, { stdio: "ignore" });
    return bin;
  } catch {
    return undefined;
  }
}

/** The same executable, inside the .app bundle, for people who never ran the PATH installer. */
function inBundle(editor) {
  if (process.platform !== "darwin") return undefined;
  for (const base of ["/Applications", path.join(os.homedir(), "Applications")]) {
    const candidate = path.join(base, editor.app, "Contents/Resources/app/bin", editor.cli);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function findEditors() {
  const found = [];
  for (const editor of EDITORS) {
    const cli = onPath(editor.bin) ?? inBundle(editor);
    if (cli) found.push({ ...editor, cli });
  }
  return found;
}

function main() {
  const pkg = JSON.parse(readFileSync(path.join(root, "packages/extension/package.json"), "utf8"));
  console.log(`\n\x1b[1m${pkg.displayName} setup\x1b[0m — ${pkg.description}`);

  step(1, "Installing dependencies");
  // `ci` rather than `install`, so a clone gets exactly the tested tree and a
  // lock file that has drifted fails here rather than three steps later.
  run("npm", ["ci"]);
  ok("dependencies installed");

  step(2, "Building and packaging the extension");
  run("npm", ["run", "package"]);
  const dist = path.join(root, "dist");
  const vsix = readdirSync(dist).filter((f) => f.endsWith(".vsix")).sort().at(-1);
  if (!vsix) {
    console.error("\n    Packaging reported success but produced no .vsix. Stopping.");
    process.exit(1);
  }
  const vsixPath = path.join(dist, vsix);
  ok(vsixPath);

  step(3, "Installing into your editor");
  const editors = findEditors();
  if (editors.length === 0) {
    warn("no editor found automatically.");
    console.log(
      [
        "",
        "    Install it by hand — it takes two clicks:",
        "      Extensions panel → the ··· menu → Install from VSIX…",
        `      then choose: ${vsixPath}`,
        "",
        "    Looked for VS Code, Insiders, Cursor, Windsurf, Antigravity, VSCodium and",
        "    Positron, both on PATH and in the usual application folders.",
      ].join("\n")
    );
  } else {
    for (const editor of editors) {
      try {
        execFileSync(editor.cli, ["--install-extension", vsixPath, "--force"], { stdio: "pipe" });
        ok(`installed into ${editor.name}`);
      } catch (err) {
        warn(`${editor.name} refused it: ${String(err.stderr ?? err.message).trim().split("\n")[0]}`);
        console.log(`      Install by hand from: ${vsixPath}`);
      }
    }
  }

  console.log(
    [
      "",
      "\x1b[1mWhat is left, and it is genuinely two steps:\x1b[0m",
      "",
      "  1. Reload the editor window  (Cmd/Ctrl+Shift+P → “Reload Window”)",
      "  2. Cmd/Ctrl+Shift+P → “Ripieno: Join Room”, then type any room code",
      "",
      "That is a working room, on your own machine, with no relay, no account and",
      "no token. Attach an agent from the Ripieno panel in the activity bar.",
      "",
      "To put other people in the room, you host a relay — there is no shared",
      "service. See docs/self-hosting.md.",
      "",
    ].join("\n")
  );
}

main();
