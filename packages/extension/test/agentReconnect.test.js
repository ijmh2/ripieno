const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const WebSocket = require("ws");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { AgentHost } = require("../dist/agentHost.js");
const FAKE_CLI = path.join(__dirname, "rosterReachesAgent.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a reconnect snapshot dedupes ids and still feeds a question missed while offline", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ripieno-reconnect-"));
  const record = path.join(dir, "prompts.jsonl");
  process.env.RIPIENO_TEST_RECORD = record;
  process.env.RIPIENO_TEST_REPLIES = JSON.stringify([{ when: "Question missed offline?", reply: "Recovered." }]);
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  let joins = 0;
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.t !== "join") return;
    joins += 1;
    const transcript = joins === 1 ? [] : [
      {
        id: "missed-question", kind: "human", authorHandle: "mira", authorName: "Mira",
        text: "Question missed offline?", ts: 2,
      },
      {
        id: "missed-question", kind: "human", authorHandle: "mira", authorName: "Mira",
        text: "Question missed offline?", ts: 2,
      },
    ];
    socket.send(JSON.stringify({
      t: "joined", room: "reconnect", mode: "byo",
      you: { handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] },
      youAgentId: "sam::agent",
      roster: [
        { handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] },
        { handle: "mira", displayName: "Mira", present: true, color: 2, role: "member", agents: [] },
      ],
      transcript,
    }));
    if (joins === 1) setTimeout(() => socket.terminate(), 30);
  }));
  const host = new AgentHost({
    url: `ws://127.0.0.1:${address.port}`, room: "reconnect",
    member: { handle: "sam", displayName: "Sam" }, id: "agent", label: "Sam's agent",
    providerId: "cli-custom", command: process.execPath, args: [FAKE_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused", workspaceServerPath: "unused", cwd: __dirname, onStateChange: () => {},
  });
  try {
    host.attach();
    let prompts = [];
    for (let attempt = 0; attempt < 200 && prompts.length === 0; attempt++) {
      const raw = await fs.readFile(record, "utf8").catch(() => "");
      prompts = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (prompts.length === 0) await wait(25);
    }
    assert.equal(joins >= 2, true);
    assert.equal(prompts.length, 1, "duplicate snapshot ids feed exactly one recovered turn");
    assert.match(prompts[0], /Question missed offline\?/);
  } finally {
    host.dispose();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
