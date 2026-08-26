/** Raw WebSocket proof that draft identity and final ids belong to the relay. */

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
  sendRaw(message: unknown): void {
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

const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("raw live-draft authorization boundary", () => {
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

  test("forged identity and entry ids are ignored, and final say reuses the relay id", async () => {
    const mira = await connect();
    mira.send({ t: "join", room: "wire-draft", member: { handle: "mira", displayName: "Mira" } });
    await mira.waitFor("joined");

    const coder = await connect();
    coder.send({
      t: "join",
      room: "wire-draft",
      member: { handle: "mira", displayName: "Mira" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
    });
    await coder.waitFor("joined");
    const reviewer = await connect();
    reviewer.send({
      t: "join",
      room: "wire-draft",
      member: { handle: "mira", displayName: "Mira" },
      role: "agent",
      agentId: "reviewer",
      agentLabel: "Mira's reviewer",
    });
    await reviewer.waitFor("joined");

    reviewer.sendRaw({
      t: "agentDraft",
      delta: "Review complete.",
      sequence: 1,
      agentId: "mira::coder",
      authorHandle: "attacker",
      authorName: "Forged",
      entryId: "client-picked",
    });
    const draft = await mira.waitFor("agentDelta", (message) => message.text === "Review complete.");
    assert.equal(draft.agentId, "mira::reviewer");
    assert.equal(draft.authorHandle, "mira");
    assert.equal(draft.authorName, "Mira's reviewer");
    assert.notEqual(draft.entryId, "client-picked");

    reviewer.send({ t: "say", text: "Review complete." });
    const final = await mira.waitFor("entry", (message) => message.entry.id === draft.entryId);
    assert.equal(final.entry.agentId, "mira::reviewer");
    assert.equal(final.entry.text, "Review complete.");
    assert.equal(
      mira.seen.filter(
        (message): message is Extract<ServerMsg, { t: "entry" }> =>
          message.t === "entry" && message.entry.id === draft.entryId
      ).length,
      1
    );
  });

  test("a human socket cannot publish or cancel an agent draft", async () => {
    const human = await connect();
    human.send({ t: "join", room: "human-draft", member: { handle: "sam", displayName: "Sam" } });
    await human.waitFor("joined");
    human.sendRaw({ t: "agentDraft", delta: "forged", sequence: 1 });
    human.sendRaw({ t: "agentDraftCancel" });
    await settle();
    assert.equal(human.seen.some((message) => message.t === "agentDelta"), false);
  });

  test("role revocation cancels the exact agent's incomplete preview", async () => {
    const owner = await connect();
    owner.send({ t: "join", room: "revoke-draft", member: { handle: "owner", displayName: "Owner" } });
    await owner.waitFor("joined");
    const sam = await connect();
    sam.send({ t: "join", room: "revoke-draft", member: { handle: "sam", displayName: "Sam" } });
    await sam.waitFor("joined");
    const agent = await connect();
    agent.send({
      t: "join",
      room: "revoke-draft",
      member: { handle: "sam", displayName: "Sam" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Sam's coder",
    });
    await agent.waitFor("joined");
    agent.send({ t: "agentDraft", delta: "unfinished", sequence: 1 });
    const draft = await owner.waitFor("agentDelta", (message) => message.text === "unfinished");

    owner.send({ t: "setRole", handle: "sam", role: "viewer" });
    const cancelled = await owner.waitFor(
      "agentDeltaCancel",
      (message) => message.entryId === draft.entryId
    );
    assert.equal(cancelled.entryId, draft.entryId);
  });
});
