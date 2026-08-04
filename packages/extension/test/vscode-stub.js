// Minimal stand-in for the `vscode` module, so the pieces of the extension that
// contain real logic can be tested outside the editor. Only the members the
// code under test actually touches are implemented — anything else should fail
// loudly rather than silently returning undefined.

class FileSystemErrorImpl extends Error {
  constructor(message, code) {
    super(typeof message === "string" ? message : String(message));
    this.code = code;
  }
}

const FileSystemError = {
  NoPermissions: (m) => new FileSystemErrorImpl(m, "NoPermissions"),
  Unavailable: (m) => new FileSystemErrorImpl(m, "Unavailable"),
  FileNotFound: (m) => new FileSystemErrorImpl(m, "FileNotFound"),
};

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (listener) => {
      this.listeners.push(listener);
      return { dispose: () => undefined };
    };
  }
  fire(value) {
    for (const listener of this.listeners) listener(value);
  }
  dispose() {}
}

class Disposable {
  constructor(fn) {
    this.dispose = fn ?? (() => undefined);
  }
}

module.exports = {
  EventEmitter,
  Disposable,
  FileSystemError,
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  Uri: {
    from: ({ scheme, path }) => ({ scheme, path, toString: () => `${scheme}:${path}` }),
    file: (p) => ({ scheme: "file", path: p, fsPath: p, toString: () => `file://${p}` }),
  },
  workspace: {
    fs: {},
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, d) => d }),
  },
  window: {
    // AgentHost logs its whole turn here. Collected rather than discarded, so a
    // test that fails can show what the agent was actually told.
    createOutputChannel: (name) => ({
      name,
      lines: [],
      appendLine(line) {
        this.lines.push(line);
      },
      dispose() {},
    }),
  },
  commands: {},
};
