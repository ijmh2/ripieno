const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return path.join(__dirname, "vscode-stub.js");
  return originalResolve.call(this, request, ...rest);
};
const vscode = require("./vscode-stub.js");
const { LiveProposalDocuments } = require("../dist/liveProposalDocuments.js");

function openDocuments() {
  const editors = new Map();
  let provider;
  vscode.workspace.registerTextDocumentContentProvider = (_scheme, value) => {
    provider = value;
    provider.onDidChange((uri) => {
      if (editors.has(uri.toString())) {
        editors.set(uri.toString(), provider.provideTextDocumentContent(uri));
      }
    });
    return { dispose() {} };
  };
  const documents = new LiveProposalDocuments();
  const open = (id, file) => {
    const uri = documents.set({ id, path: file, patch: "-old\n+new" });
    editors.set(uri.toString(), provider.provideTextDocumentContent(uri));
    return () => editors.get(uri.toString());
  };
  return { documents, open };
}

test("resolving a proposal clears its already-open editor without clearing another", () => {
  const { documents, open } = openDocuments();
  const first = open("first", "src/first.ts");
  const second = open("second", "src/second.ts");
  documents.clear("first");
  assert.equal(first(), "");
  assert.equal(second(), "-old\n+new");
  documents.clear("first");
  documents.dispose();
});

test("disconnecting or leaving a room clears every already-open proposal editor", () => {
  const { documents, open } = openDocuments();
  const first = open("first", "src/first.ts");
  const second = open("second", "src/second.ts");
  documents.clearAll();
  assert.equal(first(), "");
  assert.equal(second(), "");
  documents.dispose();
});
