/**
 * The extension manifest, checked against itself.
 *
 * Everything here is a string that VS Code resolves at runtime and silently
 * ignores when it does not match. There is no error, no warning and no log
 * line — the menu item simply never renders, or the extension never activates,
 * and the feature looks like it was never built.
 *
 * That is not hypothetical. `ripieno.setRole` shipped with `view == mpaRooms` where
 * the view's id is `ripieno.rooms`, so the only way to change anybody's role never
 * appeared for anyone; and `activationEvents` was empty, so a click on an invite
 * link did nothing at all unless the extension happened to be running already —
 * which is the one path that matters most, since an invite arrives from someone
 * who is not you.
 *
 * Both were found by an outside reading, months of use apart from the tests that
 * covered the code behind them. These assertions are cheap and they close the
 * whole class.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const manifest = require("../package.json");

const views = Object.values(manifest.contributes.views)
  .flat()
  .map((v) => v.id);
const commandDefinitions = manifest.contributes.commands;
const commands = commandDefinitions.map((c) => c.command);
const menus = Object.entries(manifest.contributes.menus).flatMap(([where, items]) =>
  items.map((item) => ({ ...item, where }))
);

describe("every menu clause names something that exists", () => {
  test("there are menus to check", () => {
    // Guards the rest: an empty list would make every assertion below vacuous.
    assert.ok(menus.length >= 5, `only ${menus.length} menu entries found`);
    assert.ok(views.length >= 2, `only ${views.length} views found`);
  });

  test("every `view == x` clause names a declared view", () => {
    for (const item of menus) {
      for (const [, id] of (item.when ?? "").matchAll(/view\s*==\s*([\w.-]+)/g)) {
        assert.ok(
          views.includes(id),
          `${item.where} → ${item.command}: when-clause names view "${id}", which is not declared. ` +
            `Declared views: ${views.join(", ")}`
        );
      }
    }
  });

  test("every menu entry names a declared command", () => {
    for (const item of menus) {
      assert.ok(
        commands.includes(item.command),
        `${item.where} names command "${item.command}", which is not declared`
      );
    }
  });

  test("every declared command is reachable somehow", () => {
    // A command with no menu entry is fine — it can still be run from the
    // palette — but it must carry a category there, or it is unfindable.
    for (const command of manifest.contributes.commands) {
      const inAMenu = menus.some((m) => m.command === command.command);
      assert.ok(
        inAMenu || command.category || command.title.includes(":"),
        `"${command.command}" is in no menu and has no palette category, so nothing can invoke it`
      );
    }
  });

  test("navigation commands have codicon icons", () => {
    for (const item of menus.filter((menu) => menu.group?.startsWith("navigation"))) {
      const command = commandDefinitions.find((entry) => entry.command === item.command);
      assert.match(
        command?.icon ?? "",
        /^\$\([\w-]+\)$/,
        `${item.where} → ${item.command} is a navigation action without a codicon`
      );
    }
  });

  test("the Room title exposes the right action for each membership state", () => {
    const roomTitle = menus.filter(
      (item) => item.where === "view/title" && (item.when ?? "").includes("view == ripieno.room")
    );
    const byCommand = new Map(roomTitle.map((item) => [item.command, item]));

    assert.equal(
      byCommand.get("ripieno.joinRoom")?.when,
      "view == ripieno.room && !ripieno.inRoom"
    );
    assert.equal(byCommand.get("ripieno.joinRoom")?.group, "navigation");
    assert.equal(
      byCommand.get("ripieno.copyInvite")?.when,
      "view == ripieno.room && ripieno.inRoom"
    );
    assert.equal(byCommand.get("ripieno.copyInvite")?.group, "navigation");
    assert.equal(
      byCommand.get("ripieno.leaveRoom")?.when,
      "view == ripieno.room && ripieno.inRoom"
    );
    assert.notEqual(
      byCommand.get("ripieno.leaveRoom")?.group,
      "navigation",
      "Leave Room belongs in the overflow, not the primary title bar"
    );
  });

  test("every custom context key used by a menu is set by the extension", () => {
    const extensionSource = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
    const setContexts = new Set(
      [...extensionSource.matchAll(/executeCommand\(\s*["']setContext["']\s*,\s*["']([^"']+)["']/g)]
        .map((match) => match[1])
    );
    const usedContexts = new Set(
      menus.flatMap((item) => {
        // View ids and TreeItem.contextValue strings are provided by contributed
        // views/items, not `setContext`; remove those equality clauses first.
        const when = (item.when ?? "").replace(/\b(?:view|viewItem)\s*==\s*[\w.-]+/g, "");
        return [...when.matchAll(/\b(ripieno\.[\w.]+)\b/g)].map((match) => match[1]);
      })
    );

    for (const key of usedContexts) {
      assert.ok(setContexts.has(key), `menu when-clause uses context "${key}", but the extension never sets it`);
    }
  });

  test("every owned agent row exposes customization beside its run control", () => {
    for (const context of [
      "ripienoAgentDetached",
      "ripienoAgentAttached",
      "ripienoAgentError",
    ]) {
      const item = menus.find(
        (menu) =>
          menu.command === "ripieno.customizeAgent" &&
          menu.where === "view/item/context" &&
          menu.when?.includes(`viewItem == ${context}`)
      );
      assert.ok(item, `no Customize Agent action for ${context}`);
      assert.ok(item.group?.startsWith("inline"), `Customize Agent is hidden for ${context}`);
    }
  });

  test("every owned agent row can be deleted without crowding the inline controls", () => {
    for (const context of [
      "ripienoAgentDetached",
      "ripienoAgentAttached",
      "ripienoAgentError",
    ]) {
      const item = menus.find(
        (menu) =>
          menu.command === "ripieno.removeAgent" &&
          menu.where === "view/item/context" &&
          menu.when?.includes(`viewItem == ${context}`)
      );
      assert.ok(item, `no Delete Agent action for ${context}`);
      assert.ok(!item.group?.startsWith("inline"), `Delete Agent crowds inline controls for ${context}`);
    }
  });
});

describe("the extension activates when it needs to", () => {
  test("onUri is declared, so an invite link can start it from cold", () => {
    // VS Code derives activation events from contribution points — onView for
    // contributed views, onCommand for commands — but a URI handler is not a
    // contribution point, so this one has to be declared by hand. Without it
    // registerUriHandler is never reached unless something else already woke
    // the extension, and the person clicking an invite is by definition the
    // one least likely to have it running.
    assert.ok(
      (manifest.activationEvents ?? []).includes("onUri"),
      "activationEvents must include onUri or invite links only work by luck"
    );
  });

  test("the views the menus hang off are contributed under one container", () => {
    const container = manifest.contributes.viewsContainers.activitybar[0].id;
    assert.ok(
      Object.keys(manifest.contributes.views).includes(container),
      `views are contributed to a container "${container}" that is not declared`
    );
  });
});
