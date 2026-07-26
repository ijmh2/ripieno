/**
 * The approval bridge, exercised for real.
 *
 * This is the path that decides what a room agent may do on a member's machine,
 * so the property that matters most is that it *fails closed*: an unreachable,
 * silent or unauthorised bridge must produce a denial, never an allowance. That
 * was asserted when it was written and never demonstrated — these tests
 * demonstrate it.
 *
 * The permission server is tested as the built bundle (dist/permissionServer.js)
 * spawned over stdio, exactly as Claude Code runs it. It imports no `vscode`
 * module, so it runs fine outside the editor; the extension-host half is stood
 * in for by a plain WebSocket server here.
 */

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SERVER = path.join(__dirname, "..", "dist", "permissionServer.js");
const TOKEN = "test-token";

/** Stands in for the extension host: answers requests however the test says. */
function fakeBridge(decide) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const seen = [];
  wss.on("connection", (socket, req) => {
    if (req.headers["x-mpa-token"] !== TOKEN) {
      socket.close(4001, "bad token");
      return;
    }
    socket.on("message", (raw) => {
      const request = JSON.parse(String(raw));
      seen.push(request);
      const verdict = decide(request);
      if (verdict) socket.send(JSON.stringify({ id: request.id, ...verdict }));
    });
  });
  const ready = new Promise((resolve) => wss.on("listening", resolve));
  return {
    seen,
    ready,
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    // Terminate clients first: wss.close() waits for every connection to go, so
    // closing while the permission server is still attached hangs forever — and
    // the request it is waiting on sits out its full decision timeout.
    close: () =>
      new Promise((r) => {
        for (const client of wss.clients) client.terminate();
        wss.close(r);
      }),
  };
}

async function askPermission(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const result = await client.callTool({
    name: "approve",
    arguments: { tool_name: "Bash", input: { command: "rm -rf /" } },
  });
  await client.close();
  return JSON.parse(result.content[0].text);
}

describe("approval bridge", () => {
  let bridge;

  before(async () => {
    bridge = fakeBridge((req) => ({ allow: req.input?.command !== "rm -rf /" }));
    await bridge.ready;
  });

  after(async () => {
    await bridge.close();
  });

  test("a denial from the member becomes a deny verdict", async () => {
    const payload = await askPermission({
      MPA_APPROVAL_URL: bridge.url(),
      MPA_APPROVAL_TOKEN: TOKEN,
      MPA_AGENT_LABEL: "Mira's agent",
    });
    assert.equal(payload.behavior, "deny");
    assert.match(payload.message, /\w/, "a denial must explain itself, or the agent just retries");
  });

  test("the request reaches the member with enough context to judge it", async () => {
    await askPermission({
      MPA_APPROVAL_URL: bridge.url(),
      MPA_APPROVAL_TOKEN: TOKEN,
      MPA_AGENT_ID: "ijmh2::reviewer",
      MPA_AGENT_LABEL: "Mira's reviewer",
    });
    const last = bridge.seen.at(-1);
    assert.equal(last.toolName, "Bash");
    assert.deepEqual(last.input, { command: "rm -rf /" });
    // Which agent is asking matters: a member with several should know which.
    assert.equal(last.agentLabel, "Mira's reviewer");
    assert.equal(last.agentId, "ijmh2::reviewer");
  });

  test("an approval from the member becomes an allow verdict", async () => {
    const allowAll = fakeBridge(() => ({ allow: true }));
    await allowAll.ready;
    const payload = await askPermission({
      MPA_APPROVAL_URL: allowAll.url(),
      MPA_APPROVAL_TOKEN: TOKEN,
    });
    assert.equal(payload.behavior, "allow");
    // The input must be echoed back, or the call runs with nothing.
    assert.deepEqual(payload.updatedInput, { command: "rm -rf /" });
    await allowAll.close();
  });
});

describe("failing closed", () => {
  test("an unreachable bridge denies rather than allows", async () => {
    // Port 1 is reserved and nothing listens there.
    const payload = await askPermission({
      MPA_APPROVAL_URL: "ws://127.0.0.1:1",
      MPA_APPROVAL_TOKEN: TOKEN,
    });
    assert.equal(payload.behavior, "deny");
    assert.match(payload.message, /bridge/i);
  });

  test("no bridge configured at all denies", async () => {
    const payload = await askPermission({
      MPA_APPROVAL_URL: "",
      MPA_APPROVAL_TOKEN: "",
    });
    assert.equal(payload.behavior, "deny");
  });

  test("a wrong token denies — another local process cannot answer for the member", async () => {
    const bridge = fakeBridge(() => ({ allow: true }));
    await bridge.ready;
    const payload = await askPermission({
      MPA_APPROVAL_URL: bridge.url(),
      MPA_APPROVAL_TOKEN: "wrong-token",
    });
    assert.equal(payload.behavior, "deny");
    await bridge.close();
  });

  test("a bridge that accepts but never answers denies when it closes", async () => {
    // Silence must not be read as consent.
    const silent = fakeBridge(() => undefined);
    await silent.ready;
    const url = silent.url();
    const pending = askPermission({ MPA_APPROVAL_URL: url, MPA_APPROVAL_TOKEN: TOKEN });
    // Close the bridge while the request is outstanding.
    setTimeout(() => void silent.close(), 300);
    const payload = await pending;
    assert.equal(payload.behavior, "deny");
  });
});
