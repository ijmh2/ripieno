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
      socket.once("open", () => resolve());
      socket.once("error", reject);
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

describe("raw handoff authorization boundary", () => {
  let relay: Relay;
  const clients: Client[] = [];
  const connect = async (): Promise<Client> => {
    const client = await Client.connect();
    clients.push(client);
    return client;
  };

  before(async () => {
    relay = startServer({ port: 0, mode: "byo" });
    url = `ws://127.0.0.1:${await relay.whenListening()}`;
  });

  after(async () => {
    for (const client of clients) client.socket.terminate();
    await relay.flush();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  test("human consent selects a recipient-owned live agent and messages no other agent", async () => {
    const mira = await connect();
    mira.send({ t: "join", room: "wire", member: { handle: "mira", displayName: "Mira" } });
    await mira.waitFor("joined");
    const sam = await connect();
    sam.send({ t: "join", room: "wire", member: { handle: "sam", displayName: "Sam" } });
    await sam.waitFor("joined");

    const source = await connect();
    source.send({
      t: "join",
      room: "wire",
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
      member: { handle: "mira", displayName: "Mira" },
    });
    const sourceJoined = await source.waitFor("joined");
    const target = await connect();
    target.send({
      t: "join",
      room: "wire",
      role: "agent",
      agentId: "reviewer",
      agentLabel: "Sam's reviewer",
      member: { handle: "sam", displayName: "Sam" },
    });
    const targetJoined = await target.waitFor("joined");

    source.send({ t: "setRole", handle: "sam", role: "viewer" });
    assert.match(
      (await source.waitFor("error", (message) => /human room owner/.test(message.message))).message,
      /only a human room owner/
    );

    // Agent sockets cannot create consent on behalf of their humans.
    source.send({
      t: "handoffOffer",
      requestId: "req_agent_offer",
      targetHandle: "sam",
      sourceAgentId: sourceJoined.youAgentId,
      task: "Review the launch blocker",
    });
    assert.match(
      (await source.waitFor("error", (message) => /human member may offer/.test(message.message))).message,
      /only a human member/
    );

    mira.send({
      t: "handoffOffer",
      requestId: "req_offer",
      targetHandle: "sam",
      sourceAgentId: sourceJoined.youAgentId,
      task: "Review the launch blocker",
    });
    const offered = await mira.waitFor(
      "handoffResult",
      (message) => message.requestId === "req_offer"
    );
    assert.equal(offered.ok, true);
    assert.equal(target.seen.some((message) => message.t === "handoffAssignment"), false);

    // A late joiner gets the same pending authoritative state.
    const kate = await connect();
    kate.send({ t: "join", room: "wire", member: { handle: "kate", displayName: "Kate" } });
    const kateJoined = await kate.waitFor("joined");
    assert.equal(kateJoined.handoffs?.[0]?.id, offered.handoff?.id);
    assert.equal(kateJoined.handoffs?.[0]?.status, "pending");

    sam.send({
      t: "handoffDecision",
      requestId: "req_accept",
      handoffId: offered.handoff!.id,
      nonce: offered.handoff!.nonce,
      action: "accept",
      expectedVersion: 1,
      targetAgentId: targetJoined.youAgentId,
    });
    const accepted = await sam.waitFor(
      "handoffResult",
      (message) => message.requestId === "req_accept"
    );
    assert.equal(accepted.ok, true);
    const assignment = await target.waitFor("handoffAssignment");
    assert.equal(assignment.context.handoff.targetHandle, "sam");
    assert.equal(source.seen.some((message) => message.t === "handoffReleased"), false);
    target.send({
      t: "handoffClaim",
      handoffId: assignment.handoffId,
      deliveryId: assignment.deliveryId,
      expectedVersion: assignment.handoffVersion,
    });
    assert.equal((await target.waitFor("handoffStart")).deliveryId, assignment.deliveryId);
    assert.equal((await source.waitFor("handoffReleased")).handoffId, offered.handoff?.id);
  });
});
