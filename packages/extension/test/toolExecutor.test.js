// Exercise the real core + EditorGate against real files and a small editor
// adapter. The adapter models versions, dirty buffers, approvals and saves;
// assertions cover observable data loss rather than source-code patterns.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

let root, documents, previews, ask, saves, applications, provider;
let failApply, failSave, afterApply, defaultEol;
const withEol = (text, eol) => text.replace(/\r\n|\r|\n/g, eol === 2 ? "\r\n" : "\n");
const uri = (scheme, file, query = "") => ({
  scheme, path: file, fsPath: file, query,
  toString: () => `${scheme}:${file}${query ? `?${query}` : ""}`,
});
const vscode = {
  Uri: { file: (file) => uri("file", file), from: ({ scheme, path, query }) => uri(scheme, path, query) },
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} },
  EndOfLine: { LF: 1, CRLF: 2 },
  Range: class {},
  WorkspaceEdit: class {
    changes = [];
    replace(target, _range, text) { this.changes.push({ target, text }); }
    createFile(target, options) { this.changes.push({ target, options }); }
  },
  workspace: {
    get textDocuments() { return [...documents.values()]; },
    get workspaceFolders() { return [{ uri: vscode.Uri.file(root) }]; },
    registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
    async openTextDocument(target) {
      if (documents.has(target.fsPath)) return documents.get(target.fsPath);
      const disk = await fs.readFile(target.fsPath, "utf8");
      const eol = disk.includes("\r\n") ? 2 : disk.includes("\n") ? 1 : defaultEol;
      const bom = disk.startsWith("\uFEFF");
      const doc = {
        uri: target, text: withEol(bom ? disk.slice(1) : disk, eol), version: 1,
        eol, bom,
        isDirty: false, isClosed: false,
        get lineCount() { return this.text.split("\n").length; },
        getText() { return this.text; },
        async save() {
          saves++;
          if (failSave) return false;
          await fs.writeFile(this.uri.fsPath, (this.bom ? "\uFEFF" : "") + this.text, "utf8");
          this.isDirty = false;
          return true;
        },
      };
      documents.set(target.fsPath, doc);
      return doc;
    },
    async applyEdit(edit) {
      applications++;
      if (failApply) return false;
      for (const change of edit.changes) {
        if (change.options) {
          assert.equal(change.options.overwrite, false);
          assert.equal(change.options.ignoreIfExists, false);
          assert.ok(change.options.contents instanceof Uint8Array);
          try { await fs.writeFile(change.target.fsPath, change.options.contents, { flag: "wx" }); }
          catch (err) { if (err.code === "EEXIST") return false; throw err; }
        } else {
          const doc = await this.openTextDocument(change.target);
          doc.text = withEol(change.text, doc.eol);
          doc.isDirty = true;
          doc.version++;
        }
      }
      await afterApply();
      return true;
    },
  },
  commands: {
    async executeCommand(command, baseline, proposed) {
      assert.equal(command, "vscode.diff");
      previews.push({ baseline, proposed });
    },
  },
  window: { showInformationMessage: (...args) => ask(...args) },
};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === "vscode" ? vscode : originalLoad.call(this, name, ...args);
};
const { ToolExecutor, registerProposedDocuments } = require("../dist/toolExecutor.js");
Module._load = originalLoad;
registerProposedDocuments();

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ripieno-editor-gate-"));
  documents = new Map(); previews = []; saves = 0; applications = 0;
  failApply = false; failSave = false; afterApply = async () => {};
  defaultEol = vscode.EndOfLine.LF;
  ask = async () => "Apply";
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const file = () => path.join(root, "shared.txt");
async function seed(text = "one\ntwo\n") {
  await fs.writeFile(file(), text, "utf8");
  return vscode.workspace.openTextDocument(vscode.Uri.file(file()));
}
const edit = (old_text = "one", new_text = "ONE") => new ToolExecutor().execute({
  name: "edit_file", input: { path: "shared.txt", old_text, new_text },
});
const create = (content = "created\n") => new ToolExecutor().execute({
  name: "write_file", input: { path: "shared.txt", content },
});

test("an unchanged approved edit is applied and saved", async () => {
  await seed();
  assert.equal((await edit()).isError, undefined);
  assert.equal(await fs.readFile(file(), "utf8"), "ONE\ntwo\n");
  assert.equal(applications, 1);
  assert.equal(saves, 1);
});

test("LF replacement text in a CRLF document is saved with the editor's line endings", async () => {
  const doc = await seed("one\r\ntwo\r\n");
  const result = await create("replacement\nnext\n");
  assert.equal(result.isError, undefined);
  assert.equal(doc.text, "replacement\r\nnext\r\n");
  assert.equal(await fs.readFile(file(), "utf8"), "replacement\r\nnext\r\n");
  assert.equal(saves, 1);
});

test("edit_file can insert LF text into a CRLF file without leaving an unsaved edit", async () => {
  await seed("one\r\ntwo\r\n");
  assert.equal((await edit("one", "ONE\nextra")).isError, undefined);
  assert.equal(await fs.readFile(file(), "utf8"), "ONE\r\nextra\r\ntwo\r\n");
  assert.equal(saves, 1);
});

test("a loaded UTF-8 BOM remains encoding metadata and is saved exactly once", async () => {
  const doc = await seed("\uFEFFone\r\ntwo\r\n");
  assert.equal(doc.getText(), "one\r\ntwo\r\n");
  assert.equal((await edit()).isError, undefined);
  assert.equal(doc.getText(), "ONE\r\ntwo\r\n");
  assert.equal(await fs.readFile(file(), "utf8"), "\uFEFFONE\r\ntwo\r\n");
  assert.equal(saves, 1);
});

test("BOM handling preserves a second leading marker that is actual document text", async () => {
  const doc = await seed("\uFEFF\uFEFFone\ntwo\n");
  assert.equal((await edit()).isError, undefined);
  assert.equal(doc.getText(), "\uFEFFONE\ntwo\n");
  assert.equal(await fs.readFile(file(), "utf8"), "\uFEFF\uFEFFONE\ntwo\n");
});

test("new file creation writes exact content despite a CRLF default and never resaves it", async () => {
  defaultEol = vscode.EndOfLine.CRLF;
  assert.equal((await create("created\nnext\n")).isError, undefined);
  assert.equal(await fs.readFile(file(), "utf8"), "created\nnext\n");
  assert.equal(saves, 0);
});

test("new file creation preserves BOM bytes and an editor reload hides the encoding marker", async () => {
  assert.equal((await create("\uFEFFcreated\r\n")).isError, undefined);
  assert.equal(await fs.readFile(file(), "utf8"), "\uFEFFcreated\r\n");
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file()));
  assert.equal(doc.getText(), "created\r\n");
  assert.equal(saves, 0);
});

test("disk-only EOL changes during approval still invalidate the raw baseline", async () => {
  await seed("one\r\ntwo\r\n");
  ask = async () => { await fs.writeFile(file(), "one\ntwo\n", "utf8"); return "Apply"; };
  assert.equal((await edit()).isError, true);
  assert.equal(await fs.readFile(file(), "utf8"), "one\ntwo\n");
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("removing only the disk BOM during approval still invalidates the raw baseline", async () => {
  await seed("\uFEFFone\ntwo\n");
  ask = async () => { await fs.writeFile(file(), "one\ntwo\n", "utf8"); return "Apply"; };
  assert.equal((await edit()).isError, true);
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("an EOL change by the member while applyEdit completes is not saved automatically", async () => {
  const doc = await seed();
  afterApply = async () => { doc.eol = vscode.EndOfLine.CRLF; doc.text = withEol(doc.text, doc.eol); doc.version++; };
  assert.equal((await edit()).isError, true);
  assert.equal(doc.getText(), "ONE\r\ntwo\r\n");
  assert.equal(await fs.readFile(file(), "utf8"), "one\ntwo\n");
  assert.equal(saves, 0);
});

test("an arbitrary edit while a CRLF replacement applies still prevents automatic saving", async () => {
  const doc = await seed("one\r\ntwo\r\n");
  afterApply = async () => { doc.text += "member text\r\n"; doc.version++; };
  assert.equal((await create("ONE\ntwo\n")).isError, true);
  assert.equal(doc.getText(), "ONE\r\ntwo\r\nmember text\r\n");
  assert.equal(await fs.readFile(file(), "utf8"), "one\r\ntwo\r\n");
  assert.equal(saves, 0);
});

test("pre-existing dirty editor content is preserved without asking or saving", async () => {
  const doc = await seed();
  doc.text = "my unsaved work"; doc.isDirty = true;
  ask = async () => { assert.fail("dirty content must not be offered for replacement"); };
  const result = await edit();
  assert.equal(result.isError, true);
  assert.match(result.content, /unsaved editor changes/);
  assert.equal(doc.text, "my unsaved work");
  assert.equal(await fs.readFile(file(), "utf8"), "one\ntwo\n");
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("typing while approval is pending invalidates the proposal", async () => {
  const doc = await seed();
  ask = async () => { doc.text = "typed while reviewing"; doc.version++; doc.isDirty = true; return "Apply"; };
  assert.equal((await edit()).isError, true);
  assert.equal(doc.text, "typed while reviewing");
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("even a reverted buffer with identical text invalidates the approved version", async () => {
  const doc = await seed();
  ask = async () => { doc.version += 2; return "Apply"; };
  assert.equal((await edit()).isError, true);
  assert.equal(applications, 0);
});

test("a disk edit during approval is preserved even if the editor has not reloaded", async () => {
  await seed();
  ask = async () => { await fs.writeFile(file(), "external update", "utf8"); return "Apply"; };
  const result = await edit();
  assert.equal(result.isError, true);
  assert.match(result.content, /Conflict/);
  assert.equal(await fs.readFile(file(), "utf8"), "external update");
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("a creation is refused if another writer creates the file during approval", async () => {
  ask = async () => { await fs.writeFile(file(), "other writer", "utf8"); return "Apply"; };
  assert.equal((await create()).isError, true);
  assert.equal(await fs.readFile(file(), "utf8"), "other writer");
  assert.equal(applications, 0);
});

test("an approved absent file is created without overwrite permission", async () => {
  assert.equal((await create()).isError, undefined);
  assert.equal(await fs.readFile(file(), "utf8"), "created\n");
});

test("concurrent previews stay distinct and only one proposal from the same base applies", { timeout: 5000 }, async () => {
  await seed();
  const approvals = [];
  let signalReady;
  const ready = new Promise((resolve) => { signalReady = resolve; });
  ask = () => new Promise((resolve) => { approvals.push(resolve); if (approvals.length === 2) signalReady(); });
  const first = edit("one", "ONE");
  const second = edit("two", "TWO");
  await ready;
  assert.equal(new Set(previews.flatMap((p) => [p.baseline.toString(), p.proposed.toString()])).size, 4);
  assert.deepEqual(previews.map((p) => provider.provideTextDocumentContent(p.baseline)), ["one\ntwo\n", "one\ntwo\n"]);
  assert.deepEqual(new Set(previews.map((p) => provider.provideTextDocumentContent(p.proposed))), new Set(["ONE\ntwo\n", "one\nTWO\n"]));
  approvals.forEach((resolve) => resolve("Apply"));
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((r) => !r.isError).length, 1);
  assert.equal(results.filter((r) => r.isError).length, 1);
  assert.equal(applications, 1); assert.equal(saves, 1);
  assert.ok(["ONE\ntwo\n", "one\nTWO\n"].includes(await fs.readFile(file(), "utf8")));
  assert.ok(previews.every((p) => provider.provideTextDocumentContent(p.proposed) === ""));
});

test("declining approval leaves both buffer and disk unchanged", async () => {
  await seed(); ask = async () => undefined;
  assert.equal((await edit()).isError, true);
  assert.equal(await fs.readFile(file(), "utf8"), "one\ntwo\n");
  assert.equal(applications, 0); assert.equal(saves, 0);
});

test("failed editor application never reports success or saves", async () => {
  await seed(); failApply = true;
  assert.equal((await edit()).isError, true);
  assert.equal(saves, 0);
});

test("failed saving reports the unsaved application accurately", async () => {
  const doc = await seed(); failSave = true;
  const result = await edit();
  assert.equal(result.isError, true);
  assert.match(result.content, /applied in the editor but could not be saved/);
  assert.equal(doc.text, "ONE\ntwo\n");
  assert.equal(doc.isDirty, true);
  assert.equal(await fs.readFile(file(), "utf8"), "one\ntwo\n");
});

test("typing while applyEdit completes is left in the buffer for manual saving", async () => {
  const doc = await seed();
  afterApply = async () => { doc.text += "member text\n"; doc.version++; };
  const result = await edit();
  assert.equal(result.isError, true);
  assert.match(result.content, /save it manually/);
  assert.equal(saves, 0);
  assert.equal(doc.text, "ONE\ntwo\nmember text\n");
});
