/** Collaboration authority exercised over actual sockets. */

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

describe("raw collaboration authorization", () => {
  let relay: Relay;
  const clients: Client[] = [];
  const connect = async (handle: string, agent = false) => {
    const client = await Client.connect(); clients.push(client);
    client.send({ t: "join", room: "collaboration-wire", member: { handle, displayName: handle },
      ...(agent ? { role: "agent" as const, agentId: "coder", agentLabel: "Coder" } : {}) });
    await client.waitFor("joined"); return client;
  };
  before(async () => { relay = startServer({ port: 0, mode: "byo" }); url = `ws://127.0.0.1:${await relay.whenListening()}`; });
  after(async () => { for (const c of clients) c.socket.terminate(); await relay.flush(); await new Promise<void>(resolve => relay.close(() => resolve())); });
  test("typed work uses socket attribution and rejects viewer, agent and peer authority escalation", async () => {
    const owner=await connect("mira"); const peer=await connect("sam");
    const work={type:"task",assigneeHandle:"sam",progress:"todo",steps:[]};
    owner.sendRaw({t:"contextCreate",requestId:"create",kind:"note",title:"Review selected code",body:"Review",collaboration:work,authorHandle:"sam"});
    const made=await owner.waitFor("contextResult",m=>m.requestId==="create");assert.equal(made.ok,true);assert.equal(made.item!.authorHandle,"mira");assert.deepEqual(made.item!.collaboration,work);
    peer.sendRaw({t:"contextUpdate",requestId:"advance",contextId:made.item!.id,expectedVersion:1,collaboration:{...work,progress:"doing"}});
    const advanced=await peer.waitFor("contextResult",m=>m.requestId==="advance");assert.equal(advanced.ok,true);assert.equal(advanced.contextAudit!.at(-1)!.actorHandle,"sam");
    peer.sendRaw({t:"contextUpdate",requestId:"steal",contextId:made.item!.id,expectedVersion:2,collaboration:{...work,assigneeHandle:"mira"}});
    assert.equal((await peer.waitFor("contextResult",m=>m.requestId==="steal")).ok,false);
    const agent=await connect("mira",true);agent.sendRaw({t:"contextCreate",requestId:"agent",kind:"note",title:"Unauthorized assignment",body:"",collaboration:work});assert.equal((await agent.waitFor("contextResult",m=>m.requestId==="agent")).ok,false);
    owner.send({t:"setRole",handle:"sam",role:"viewer"});await peer.waitFor("roster",m=>m.roster.some(x=>x.handle==="sam"&&x.role==="viewer"));
    peer.sendRaw({t:"contextCreate",requestId:"viewer",kind:"note",title:"Viewer work",body:"",collaboration:work});assert.equal((await peer.waitFor("contextResult",m=>m.requestId==="viewer")).ok,false);
    owner.sendRaw({t:"contextCreate",requestId:"malformed",kind:"note",title:"Malformed",body:"",collaboration:{...work,progress:"invented"}});assert.equal((await owner.waitFor("contextResult",m=>m.requestId==="malformed")).ok,false);
  });
});
