const path = require("node:path");
const fs = require("node:fs");
const {
  downloadAndUnzipVSCode,
  runTests,
  runVSCodeCommand,
} = require("@vscode/test-electron");

async function main() {
  const extensionRoot = path.resolve(__dirname, "..");
  const repositoryRoot = path.resolve(extensionRoot, "../..");
  const manifest = require(path.join(extensionRoot, "package.json"));
  const vsix = path.join(repositoryRoot, "dist", `${manifest.name}-${manifest.version}.vsix`);
  if (!fs.existsSync(vsix)) throw new Error(`Package the extension first: missing ${vsix}`);

  const version = process.env.RIPIENO_VSCODE_VERSION || "1.85.0";
  const vscodeExecutablePath = await downloadAndUnzipVSCode(version);
  await runVSCodeCommand(["--install-extension", vsix, "--force"], { version });
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: path.join(__dirname, "driver"),
    extensionTestsPath: path.join(__dirname, "suite"),
    launchArgs: [extensionRoot, "--disable-workspace-trust", "--skip-welcome"],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
