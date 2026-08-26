/**
 * Presence over a real socket, from a client that does not play fair.
 *
 * The unit tests call the room directly, which cannot answer the only question
 * an attacker cares about: whether the frame on the wire gets to choose who it
 * describes. It does not — the relay reads identity from the connection and
 * ignores anything the payload says about it — and this is where that is
 * actually demonstrated rather than asserted about a method signature.
 */

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
  /** Deliberately unshaped, so the test can send what a client never would. */
  sendRaw(payload: unknown): void {
    this.socket.send(JSON.stringify(payload));
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

const settle = (ms = 400): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("raw presence authorization boundary", () => {
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

  test("a payload cannot attribute presence to another agent", async () => {
    const mira = await connect();
    mira.send({ t: "join", room: "presence", member: { handle: "mira", displayName: "Mira" } });
    await mira.waitFor("joined");

    const coder = await connect();
    coder.send({
      t: "join",
      room: "presence",
      member: { handle: "mira", displayName: "Mira" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
      agentCapability: "workspace",
    });
    await mira.waitFor("roster", (message) =>
      message.roster.some((member) => member.agents.some((agent) => agent.id === "mira::coder"))
    );
    const reviewer = await connect();
    reviewer.send({
      t: "join",
      room: "presence",
      member: { handle: "mira", displayName: "Mira" },
      role: "agent",
      agentId: "reviewer",
      agentLabel: "Mira's reviewer",
      agentCapability: "conversation",
    });
    await mira.waitFor("roster", (message) =>
      message.roster.some((member) => member.agents.some((agent) => agent.id === "mira::reviewer"))
    );

    // The reviewer says it is the coder, editing the coder's file.
    reviewer.sendRaw({
      t: "agentActivity",
      agentId: "mira::coder",
      owner: "someone-else",
      phase: "editing",
      summary: "Editing the release script",
      path: "scripts/release.sh",
      line: 12,
      endLine: 40,
      sequence: 1,
    });
    await settle();

    const roster = mira.seen
      .filter((message): message is Extract<ServerMsg, { t: "roster" }> => message.t === "roster")
      .at(-1);
    const agents = roster?.roster.flatMap((member) => member.agents) ?? [];
    const coderEntry = agents.find((agent) => agent.id === "mira::coder");
    const reviewerEntry = agents.find((agent) => agent.id === "mira::reviewer");
    assert.equal(coderEntry?.activity, undefined, "the impersonated agent reports nothing");
    assert.equal(reviewerEntry?.activity?.phase, "editing", "the sender describes only itself");
    assert.equal(reviewerEntry?.owner, "mira", "and ownership comes from the connection");
  });

  test("a human connection cannot report agent presence at all", async () => {
    const sam = await connect();
    sam.send({ t: "join", room: "presence", member: { handle: "sam", displayName: "Sam" } });
    await sam.waitFor("joined");
    sam.sendRaw({ t: "agentActivity", phase: "editing", summary: "Editing everything", sequence: 1 });
    await settle();
    const roster = sam.seen
      .filter((message): message is Extract<ServerMsg, { t: "roster" }> => message.t === "roster")
      .at(-1);
    const sams = roster?.roster.find((member) => member.handle === "sam");
    assert.equal(sams?.agents.length, 0, "a person has no presence of their own to report");
  });

  test("an exact location needs a shared workspace, whatever the frame claims", async () => {
    const kate = await connect();
    kate.send({ t: "join", room: "private", member: { handle: "kate", displayName: "Kate" } });
    await kate.waitFor("joined");
    const agent = await connect();
    agent.send({
      t: "join",
      room: "private",
      member: { handle: "kate", displayName: "Kate" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Kate's coder",
      agentCapability: "workspace",
    });
    await kate.waitFor("roster", (message) =>
      message.roster.some((member) => member.agents.some((entry) => entry.id === "kate::coder"))
    );
    agent.send({
      t: "agentActivity",
      phase: "editing",
      summary: "Editing a private copy",
      path: "src/private.ts",
      line: 4,
      endLine: 9,
      sequence: 1,
    });
    await settle();
    const roster = kate.seen
      .filter((message): message is Extract<ServerMsg, { t: "roster" }> => message.t === "roster")
      .at(-1);
    const presence = roster?.roster.flatMap((member) => member.agents)[0]?.activity;
    assert.equal(presence?.phase, "editing", "the phase and summary are still shared");
    assert.equal(presence?.path, undefined, "but no room-wide path is claimed");
    assert.equal(presence?.line, undefined);
    assert.equal(presence?.endLine, undefined);
  });
});
