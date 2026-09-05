/** Raw WebSocket proof that proposal identity belongs to the relay. */

import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { ClientMsg, ServerMsg } from "@ripieno/protocol";
import { startServer, type Relay } from "../src/server.js";

let url = "";

class Client {
  readonly seen: ServerMsg[] = [];
  private constructor(readonly socket: WebSocket) {
    socket.on("message", (raw: WebSocket.RawData) => this.seen.push(JSON.parse(String(raw)) as ServerMsg));
  }
  static async connect(): Promise<Client> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new Client(socket);
  }
  send(message: ClientMsg): void { this.socket.send(JSON.stringify(message)); }
  sendRaw(message: unknown): void { this.socket.send(JSON.stringify(message)); }
  waitFor<T extends ServerMsg["t"]>(
    type: T,
    predicate: (message: Extract<ServerMsg, { t: T }>) => boolean = () => true
  ): Promise<Extract<ServerMsg, { t: T }>> {
    const found = this.seen.find(
      (message): message is Extract<ServerMsg, { t: T }> =>
        message.t === type && predicate(message as Extract<ServerMsg, { t: T }>)
    );
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 2_000);
      const onMessage = (raw: WebSocket.RawData): void => {
        const message = JSON.parse(String(raw)) as ServerMsg;
        if (message.t !== type || !predicate(message as Extract<ServerMsg, { t: T }>)) return;
        clearTimeout(timer);
        this.socket.off("message", onMessage);
        resolve(message as Extract<ServerMsg, { t: T }>);
      };
      this.socket.on("message", onMessage);
    });
  }
}

describe("raw proposal authorization boundary", () => {
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

  test("forged identity and proposal ids are discarded while host scope is enforced", async () => {
    const human = await connect();
    human.send({ t: "join", room: "wire-proposal", member: { handle: "mira", displayName: "Mira" } });
    await human.waitFor("joined");
    human.send({ t: "claimWorkspace", claim: true });

    const coder = await connect();
    coder.send({
      t: "join",
      room: "wire-proposal",
      member: { handle: "mira", displayName: "Mira" },
      role: "agent",
      agentId: "coder",
      agentLabel: "Mira's coder",
    });
    await coder.waitFor("joined");
    coder.sendRaw({
      t: "agentProposal",
      path: "src/a.ts",
      locationScope: "shared",
      patch: "-old\n+new",
      sequence: 1,
      agentId: "somebody::forged",
      proposalId: "client-picked",
      authorHandle: "attacker",
    });

    const update = await human.waitFor("agentProposalUpdate");
    assert.equal(update.proposal.agentId, "mira::coder");
    assert.equal(update.proposal.authorHandle, "mira");
    assert.notEqual(update.proposal.id, "client-picked");

    human.sendRaw({
      t: "agentProposal",
      path: "src/forged.ts",
      locationScope: "shared",
      patch: "+forged",
      sequence: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      human.seen.filter((message) => message.t === "agentProposalUpdate").length,
      1,
      "a human socket cannot publish an agent proposal"
    );
  });
});
