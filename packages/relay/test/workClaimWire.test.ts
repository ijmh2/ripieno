/** Work-claim authority exercised over actual sockets. */

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

describe("raw work claim authorization", () => {
  let relay: Relay;
  const clients: Client[] = [];
  const connect = async (handle: string, agent = false) => {
    const client = await Client.connect(); clients.push(client);
    client.send({ t: "join", room: "claim-wire", member: { handle, displayName: handle },
      ...(agent ? { role: "agent" as const, agentId: "coder", agentLabel: "Coder" } : {}) });
    await client.waitFor("joined"); return client;
  };
  before(async () => { relay = startServer({ port: 0, mode: "byo" }); url = `ws://127.0.0.1:${await relay.whenListening()}`; });
  after(async () => { for (const c of clients) c.socket.terminate(); await relay.flush(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  test("the socket owns claims; agents, viewers, and peers cannot impersonate the holder", async () => {
    const owner = await connect("mira"); const peer = await connect("sam");
    owner.sendRaw({ t: "workClaimCreate", requestId: "create", task: "Tests", paths: [], ownerHandle: "sam", ownerName: "Forged", expiresAt: Number.MAX_SAFE_INTEGER });
    const state = await peer.waitFor("workClaims");
    assert.equal(state.claims[0].ownerHandle, "mira");
    assert.ok(state.claims[0].expiresAt < Date.now() + 100_000);
    peer.send({ t: "workClaimRelease", requestId: "steal", claimId: state.claims[0].id });
    assert.equal((await peer.waitFor("workClaimResult", m => m.requestId === "steal")).ok, false);
    const coder = await connect("mira", true);
    coder.sendRaw({ t: "workClaimCreate", requestId: "agent", task: "Forged", paths: [] });
    assert.match((await coder.waitFor("error")).message, /human/);
    owner.send({ t: "setRole", handle: "sam", role: "viewer" });
    await peer.waitFor("roster", m => m.roster.some(member => member.handle === "sam" && member.role === "viewer"));
    peer.send({ t: "workClaimCreate", requestId: "viewer", task: "Viewer", paths: [] });
    assert.equal((await peer.waitFor("workClaimResult", m => m.requestId === "viewer")).ok, false);
  });
});
