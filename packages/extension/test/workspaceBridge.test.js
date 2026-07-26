/**
 * The loopback bridge that gives an extension-started agent shared-workspace
 * tools.
 *
 * It exists to avoid a second room connection: AgentHost already holds one, so
 * the agent's MCP server asks *it* rather than joining itself. That indirection
 * is invisible when it works and silent when it doesn't — a broken bridge looks
 * like a slow tool — so the failure paths matter as much as the happy one.
 *
 * Tested as the built bundle spawned over stdio, exactly as Claude Code runs it.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SERVER = path.join(__dirname, "..", "dist", "workspaceServer.js");
const TOKEN = "workspace-token";

/** Stands in for AgentHost: answers tool calls however the test says. */
function fakeHost(handle) {
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
      const reply = handle(request);
      if (reply) socket.send(JSON.stringify({ id: request.id, ...reply }));
    });
  });
  return {
    seen,
    ready: new Promise((resolve) => wss.on("listening", resolve)),
    url: () => `ws://127.0.0.1:${wss.address().port}`,
    // Terminate first: wss.close() waits for clients, so closing with the
    // server still attached would hang the test rather than the code.
    close: () =>
      new Promise((r) => {
        for (const client of wss.clients) client.terminate();
        wss.close(r);
      }),
  };
}

async function callTool(env, name, args) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, ...env },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const result = await client.callTool({ name, arguments: args });
  const tools = (await client.listTools()).tools.map((t) => t.name);
  await client.close();
  return { text: result.content[0].text, isError: result.isError === true, tools };
}

describe("workspace bridge", () => {
  test("a tool call reaches AgentHost and its answer comes back", async () => {
    const host = fakeHost(() => ({ content: "file contents", isError: false }));
    await host.ready;

    const result = await callTool(
      { MPA_WORKSPACE_URL: host.url(), MPA_WORKSPACE_TOKEN: TOKEN },
      "workspace_read_file",
      { path: "src/index.ts" }
    );

    assert.equal(result.text, "file contents");
    assert.equal(result.isError, false);
    // The request must carry the tool and its input unchanged — AgentHost
    // forwards these straight to the room.
    assert.equal(host.seen.at(-1).name, "read_file");
    assert.equal(host.seen.at(-1).input.path, "src/index.ts");
    await host.close();
  });

  test("the agent is offered the whole workspace toolset", async () => {
    const host = fakeHost(() => ({ content: "ok", isError: false }));
    await host.ready;
    const result = await callTool(
      { MPA_WORKSPACE_URL: host.url(), MPA_WORKSPACE_TOKEN: TOKEN },
      "workspace_list_dir",
      {}
    );
    for (const expected of [
      "workspace_read_file",
      "workspace_list_dir",
      "workspace_search",
      "workspace_write_file",
      "workspace_edit_file",
      "workspace_run_command",
    ]) {
      assert.ok(result.tools.includes(expected), `missing ${expected}`);
    }
    await host.close();
  });

  test("an error from the host is reported as an error, not as content", async () => {
    // Otherwise a refusal reads to the agent as a successful empty result.
    const host = fakeHost(() => ({ content: "The user declined.", isError: true }));
    await host.ready;
    const result = await callTool(
      { MPA_WORKSPACE_URL: host.url(), MPA_WORKSPACE_TOKEN: TOKEN },
      "workspace_write_file",
      { path: "a.ts", content: "x" }
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /declined/);
    await host.close();
  });

  test("an unreachable bridge fails loudly rather than hanging", async () => {
    const result = await callTool(
      { MPA_WORKSPACE_URL: "ws://127.0.0.1:1", MPA_WORKSPACE_TOKEN: TOKEN },
      "workspace_read_file",
      { path: "a.ts" }
    );
    assert.equal(result.isError, true);
    assert.match(result.text, /cannot reach the workspace/i);
  });

  test("a wrong token is refused — another local process cannot drive this agent", async () => {
    const host = fakeHost(() => ({ content: "should never be reached", isError: false }));
    await host.ready;
    const result = await callTool(
      { MPA_WORKSPACE_URL: host.url(), MPA_WORKSPACE_TOKEN: "wrong" },
      "workspace_read_file",
      { path: "a.ts" }
    );
    assert.equal(result.isError, true);
    assert.equal(host.seen.length, 0, "an unauthorised caller must not reach AgentHost at all");
    await host.close();
  });

  test("a host that goes away mid-call answers rather than leaving the agent waiting", async () => {
    const host = fakeHost(() => undefined);
    await host.ready;
    const pending = callTool(
      { MPA_WORKSPACE_URL: host.url(), MPA_WORKSPACE_TOKEN: TOKEN },
      "workspace_run_command",
      { command: "npm test" }
    );
    setTimeout(() => void host.close(), 300);
    const result = await pending;
    assert.equal(result.isError, true);
    assert.match(result.text, /closed before answering/i);
  });
});
