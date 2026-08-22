const assert = require("node:assert/strict");
const vscode = require("vscode");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

exports.run = async function run() {
  const extension = vscode.extensions.getExtension("ijmh2.ripieno");
  assert.ok(extension, "the packaged VSIX is installed in the Extension Host profile");
  await extension.activate();
  assert.equal(extension.isActive, true, "Ripieno activates in a real Extension Host");

  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "ripieno.joinRoom",
    "ripieno.addAgent",
    "ripieno.attachAgent",
    "ripieno.copyInvite",
    "ripieno.leaveRoom",
  ]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
  const joining = vscode.commands.executeCommand("ripieno.joinRoom");
  await wait(300);
  await vscode.commands.executeCommand("type", { text: "extension-host-smoke" });
  await vscode.commands.executeCommand("workbench.action.acceptSelectedQuickOpenItem");
  await joining;
  await wait(500);

  await vscode.commands.executeCommand("ripieno.attachAgent");
  await wait(250);
  await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
  await vscode.commands.executeCommand("ripieno.leaveRoom");
  assert.equal(extension.isActive, true, "solo join and onboarding leave the host healthy");
};
