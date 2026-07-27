/**
 * Who may answer a tool call, and whose answer arrives.
 *
 * Both bugs here came from one decision: keying outstanding calls by an id the
 * client chose. Every client counts from zero independently — `fs_0`, `rt_1`,
 * `w_0` — so ids collide between members, and anyone who can guess one can
 * answer a call that was never sent to them.
 *
 * The relay already got this right one function away: `toolResult` refuses a
 * result from anyone but the member the call was dispatched to, and agent ids
 * are namespaced by owner for exactly this reason. The remote path had neither.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { WebSocketServer } from "ws";
import type { ActionEntry, ClientMsg, ServerMsg } from "@mpa/protocol";
import { startServer } from "../src/server.js";

const PORT = 8907;
const URL = `ws://localhost:${PORT}`;

class Client {
  readonly received: ServerMsg[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw: WebSocket.RawData) =>
      this.received.push(JSON.parse(String(raw)) as ServerMsg)
    );
  }

  static async join(room: string, msg: Partial<ClientMsg> & Record<string, unknown>): Promise<Client> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const client = new Client(socket);
    socket.send(JSON.stringify({ t: "join", room, ...msg }));
    await settle(120);
    return client;
  }

  send(msg: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** What the host was actually asked to do, with the id it must echo back. */
  requests(): Array<{ requestId: string; name: string; input: Record<string, unknown> }> {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "remoteToolRequest" }> => m.t === "remoteToolRequest")
      .map((m) => ({ requestId: m.requestId, name: m.name, input: m.input }));
  }

  replies(): Array<{ requestId: string; content: string; isError?: boolean }> {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "remoteToolReply" }> => m.t === "remoteToolReply")
      .map((m) => ({ requestId: m.requestId, content: m.content, isError: m.isError }));
  }

  actions(): ActionEntry[] {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "action" }> => m.t === "action")
      .map((m) => m.entry);
  }

  close(): void {
    this.socket.terminate();
  }
}

const settle = (ms = 200): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("a tool result is only accepted from the member it was sent to", () => {
  let wss: WebSocketServer;
  const open: Client[] = [];

  before(async () => {
    wss = startServer({ port: PORT, mode: "byo" });
    await settle(150);
  });

  after(async () => {
    for (const c of open) c.close();
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  const join = async (room: string, msg: Record<string, unknown>): Promise<Client> => {
    const c = await Client.join(room, msg as never);
    open.push(c);
    return c;
  };

  /** Mira hosting a workspace, with his agent attached, in a fresh room. */
  async function room(code: string): Promise<{ host: Client; agent: Client }> {
    const host = await join(code, { member: { handle: "ijmh2", displayName: "Mira" } });
    host.send({ t: "claimWorkspace", claim: true });
    const agent = await join(code, {
      member: { handle: "ijmh2", displayName: "Mira" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
    });
    await settle();
    return { host, agent };
  }

  test("an outsider cannot answer a call that was sent to somebody else", async () => {
    const { host, agent } = await room("forge");
    const mallory = await join("forge", { member: { handle: "mallory", displayName: "Mallory" } });

    agent.send({
      t: "remoteTool",
      requestId: "fs_0",
      targetHandle: "room",
      name: "read_file",
      input: { path: "package.json" },
    });
    await settle();

    const asked = host.requests();
    assert.equal(asked.length, 1, "the host should have been asked");

    // Mallory answers, using both the agent's own id and the id the host was
    // given — neither may work.
    mallory.send({ t: "remoteToolResult", requestId: "fs_0", content: "FORGED" });
    mallory.send({ t: "remoteToolResult", requestId: asked[0]!.requestId, content: "FORGED" });
    await settle();

    assert.deepEqual(
      agent.replies().filter((r) => r.content === "FORGED"),
      [],
      "a member who was never asked must not be able to answer"
    );

    // And the genuine answer still gets through afterwards.
    host.send({ t: "remoteToolResult", requestId: asked[0]!.requestId, content: "REAL" });
    await settle();
    assert.equal(agent.replies().at(-1)?.content, "REAL");
  });

  test("two agents using the same id each get their own answer", async () => {
    // Every client mints ids from its own counter, so `fs_0` from Mira's agent
    // and `fs_0` from Sam's are different calls that used to share a map entry:
    // one agent received the other's file, and the action log named the wrong
    // agent as having read it.
    const host = await join("collide", { member: { handle: "ijmh2", displayName: "Mira" } });
    host.send({ t: "claimWorkspace", claim: true });
    const miras = await join("collide", {
      member: { handle: "ijmh2", displayName: "Mira" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
    });
    const sams = await join("collide", {
      member: { handle: "swhitfield", displayName: "Sam" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Sam's coder",
    });
    await settle();

    miras.send({
      t: "remoteTool",
      requestId: "fs_0",
      targetHandle: "room",
      name: "read_file",
      input: { path: "secrets.env" },
    });
    sams.send({
      t: "remoteTool",
      requestId: "fs_0",
      targetHandle: "room",
      name: "read_file",
      input: { path: "README.md" },
    });
    await settle();

    const asked = host.requests();
    assert.equal(asked.length, 2, "both calls must reach the host as distinct requests");
    assert.notEqual(asked[0]!.requestId, asked[1]!.requestId, "the relay must not reuse an id");

    for (const r of asked) {
      host.send({ t: "remoteToolResult", requestId: r.requestId, content: `contents of ${r.input.path}` });
    }
    await settle();

    // Each agent gets its own file back, under the id it chose.
    assert.deepEqual(miras.replies(), [{ requestId: "fs_0", content: "contents of secrets.env", isError: false }]);
    assert.deepEqual(sams.replies(), [{ requestId: "fs_0", content: "contents of README.md", isError: false }]);

    // And the work is attributed to whoever actually did it.
    const byAgent = new Map(host.actions().map((a) => [a.target, a.agentLabel]));
    assert.equal(byAgent.get("secrets.env"), "Mira's coder");
    assert.equal(byAgent.get("README.md"), "Sam's coder");
  });

  test("a host that disappears mid-call fails it instead of leaving the agent hanging", async () => {
    const { host, agent } = await room("vanish");
    agent.send({
      t: "remoteTool",
      requestId: "fs_9",
      targetHandle: "room",
      name: "run_command",
      input: { command: "npm test" },
    });
    await settle();
    assert.equal(host.requests().length, 1);

    host.close();
    await settle(400);

    const reply = agent.replies().find((r) => r.requestId === "fs_9");
    assert.ok(reply, "the agent must be told, not left to time out after five minutes");
    assert.equal(reply?.isError, true);
    assert.match(reply!.content, /ijmh2/);
  });
});
