const { execFileSync } = require("node:child_process");
const { accessSync, constants, existsSync, statSync } = require("node:fs");
const path = require("node:path");

function onPath(bin) {
  const suffixes = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory.replace(/^"|"$/g, ""), bin + suffix);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return candidate;
      } catch { /* Try the next PATH entry. */ }
    }
  }
  return undefined;
}

function npmCli() {
  const npm = onPath("npm");
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    npm && path.join(path.dirname(npm), "node_modules/npm/bin/npm-cli.js"),
    npm && path.resolve(path.dirname(npm), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const cli = candidates.find((candidate) => candidate && existsSync(candidate) && /npm-cli\.js$/i.test(candidate));
  if (!cli) throw new Error("Cannot find npm's CLI. Install Node.js with npm, then run npm run setup.");
  return cli;
}

function runNpm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli(), ...args], options);
}

function runCli(command, args, options = {}) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(command)) {
    return execFileSync(command, args, options);
  }
  // A .cmd shim needs cmd.exe, unlike npm which we can invoke through Node.
  // Fixed quoted arguments support ordinary install paths (including spaces).
  // Refuse shell expansion characters instead of interpreting an unusual local
  // path as a command; setup then prints the manual VSIX installation path.
  const quote = (value) => {
    if (/["\r\n%!^&|<>]/.test(value)) {
      throw new Error("This editor or VSIX path contains shell expansion characters; install the VSIX manually.");
    }
    return `"${value}"`;
  };
  const line = [command, ...args].map(quote).join(" ");
  return execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

module.exports = { onPath, npmCli, runNpm, runCli };
