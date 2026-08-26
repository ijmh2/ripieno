import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { ClientMsg, ServerMsg } from "@ripieno/protocol";
import { startServer, type Relay } from "../src/server.js";

let url = "";

class Client {
  readonly seen: ServerMsg[] = [];

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: WebSocket.RawData) => {
      this.seen.push(JSON.parse(String(raw)) as ServerMsg);
    });
  }

  static async connect(): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out connecting")), 2_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new Client(socket);
  }

  send(message: ClientMsg): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor<T extends ServerMsg["t"]>(
    type: T,
    predicate: (message: Extract<ServerMsg, { t: T }>) => boolean = () => true
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const existing = this.seen.find(
      (message): message is Extract<ServerMsg, { t: T }> =>
        message.t === type && predicate(message as Extract<ServerMsg, { t: T }>)
    );
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off("message", onMessage);
        reject(new Error(`timed out waiting for ${type}`));
      }, 2_000);
      const onMessage = (raw: WebSocket.RawData): void => {
        const message = JSON.parse(String(raw)) as ServerMsg;
        if (message.t === type && predicate(message as Extract<ServerMsg, { t: T }>)) {
          clearTimeout(timer);
          this.socket.off("message", onMessage);
          resolve(message as Extract<ServerMsg, { t: T }>);
        }
      };
      this.socket.on("message", onMessage);
    });
  }
}

describe("raw goal mutation boundary", () => {
  let relay: Relay;
  const clients: Client[] = [];

  async function connect(): Promise<Client> {
    const client = await Client.connect();
    clients.push(client);
    return client;
  }

  before(async () => {
    relay = startServer({ port: 0, mode: "byo", workspaceToken: "workspace-secret" });
    url = `ws://127.0.0.1:${await relay.whenListening()}`;
  });

  after(async () => {
    for (const client of clients) client.socket.terminate();
    await relay.flush();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  test("agent and workspace sockets are refused even with valid room identities", async () => {
    const human = await connect();
    human.send({ t: "join", room: "roles", member: { handle: "ivan", displayName: "Ivan" } });
    await human.waitFor("joined");

    const agent = await connect();
    agent.send({
      t: "join",
      room: "roles",
      role: "agent",
      member: { handle: "ivan", displayName: "Ivan" },
    });
    await agent.waitFor("joined");
    agent.send({ t: "goalCreate", requestId: "req_agent", text: "Agent-authored" });
    assert.match((await agent.waitFor("error")).message, /only a human member/);

    const workspace = await connect();
    workspace.send({
      t: "join",
      room: "roles",
      role: "workspace",
      workspaceToken: "workspace-secret",
      member: { handle: "container", displayName: "Container" },
    });
    await workspace.waitFor("joined");
    workspace.send({ t: "goalCreate", requestId: "req_workspace", text: "Container-authored" });
    assert.match((await workspace.waitFor("error")).message, /only a human member/);
  });

  test("a lost acknowledgement is retried with one id and returns current state", async () => {
    const first = await connect();
    first.send({ t: "join", room: "retry", member: { handle: "ivan", displayName: "Ivan" } });
    await first.waitFor("joined");
    const create: ClientMsg = { t: "goalCreate", requestId: "req_lost", text: "Stay current" };
    first.send(create);
    const created = await first.waitFor("goalResult", (message) => message.requestId === "req_lost");
    first.send({
      t: "goalTransition",
      requestId: "req_pause",
      goalId: created.goal!.id,
      action: "pause",
      expectedVersion: 1,
    });
    await first.waitFor("goalResult", (message) => message.requestId === "req_pause");
    first.socket.terminate();

    const reconnected = await connect();
    reconnected.send({
      t: "join",
      room: "retry",
      member: { handle: "ivan", displayName: "Ivan" },
    });
    const joined = await reconnected.waitFor("joined");
    assert.equal(joined.goals?.[0]?.status, "paused");
    reconnected.send(create);
    const replay = await reconnected.waitFor(
      "goalResult",
      (message) => message.requestId === "req_lost"
    );
    assert.equal(replay.goal?.status, "paused");
    assert.equal(replay.goal?.version, 2);
    assert.equal(replay.goals?.[0]?.status, "paused");
  });

  test("an empty room is reaped without losing its in-process goal snapshot", async () => {
    const first = await connect();
    first.send({ t: "join", room: "memory-reap", member: { handle: "sam", displayName: "Sam" } });
    await first.waitFor("joined");
    first.send({ t: "goalCreate", requestId: "req_memory", text: "Survive reap" });
    const created = await first.waitFor(
      "goalResult",
      (message) => message.requestId === "req_memory"
    );
    first.socket.terminate();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const returned = await connect();
    returned.send({
      t: "join",
      room: "memory-reap",
      member: { handle: "sam", displayName: "Sam" },
    });
    const joined = await returned.waitFor("joined");
    assert.equal(joined.goals?.[0]?.id, created.goal?.id);
    assert.equal(joined.roomRevision, 1);
  });

  test("agent context proposals derive exact provenance from the authenticated socket", async () => {
    const human = await connect();
    human.send({
      t: "join",
      room: "agent-context",
      member: { handle: "ivan", displayName: "Ivan" },
    });
    await human.waitFor("joined");

    const agent = await connect();
    agent.send({
      t: "join",
      room: "agent-context",
      role: "agent",
      agentId: "reviewer",
      agentLabel: "Ivan's reviewer",
      member: { handle: "ivan", displayName: "Ivan" },
    });
    await agent.waitFor("joined");
    agent.send({
      t: "contextCreate",
      requestId: "ctxreq_wire",
      kind: "fact",
      title: "Wire attribution",
      body: "The relay derives the agent id.",
      tags: ["security"],
    });
    const result = await agent.waitFor(
      "contextResult",
      (message) => message.requestId === "ctxreq_wire"
    );
    assert.equal(result.ok, true);
    assert.equal(result.item?.status, "proposed");
    assert.equal(result.item?.authorHandle, "ivan");
    assert.equal(result.item?.authorAgentId, "ivan::reviewer");
    assert.equal(result.item?.authorAgentLabel, "Ivan's reviewer");
  });
});
