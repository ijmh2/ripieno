/**
 * End-to-end over real WebSockets, in BYO mode — no API key, no Anthropic
 * resources, no credit balance. This is the credential-free proof that the
 * multiplayer path works: two people in one room, plus one member's own agent
 * posting back into it.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { WebSocketServer } from "ws";
import type { ClientMsg, ServerMsg, TranscriptEntry } from "@ripieno/protocol";
import { startServer } from "../src/server.js";

const PORT = 8899;
const URL = `ws://localhost:${PORT}`;

class TestClient {
  private readonly socket: WebSocket;
  readonly received: ServerMsg[] = [];

  /** Why the relay hung up, if it did — an eviction shows up here as 4000. */
  readonly closes: Array<{ code: number; reason: string }> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw: WebSocket.RawData) => {
      this.received.push(JSON.parse(String(raw)) as ServerMsg);
    });
    socket.on("close", (code: number, reason: Buffer) => {
      this.closes.push({ code, reason: String(reason) });
    });
  }

  get open(): boolean {
    return this.socket.readyState === this.socket.OPEN;
  }

  static async connect(): Promise<TestClient> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new TestClient(socket);
  }

  send(msg: ClientMsg): void {
    this.socket.send(JSON.stringify(msg));
  }

  entries(): TranscriptEntry[] {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry);
  }

  /** Resolve once an entry matching the predicate arrives, or reject on timeout. */
  waitForEntry(match: (e: TranscriptEntry) => boolean, ms = 2000): Promise<TranscriptEntry> {
    const found = this.entries().find(match);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off("message", onMessage);
        reject(new Error("timed out waiting for entry"));
      }, ms);
      const onMessage = (raw: WebSocket.RawData): void => {
        const msg = JSON.parse(String(raw)) as ServerMsg;
        if (msg.t === "entry" && match(msg.entry)) {
          clearTimeout(timer);
          this.socket.off("message", onMessage);
          resolve(msg.entry);
        }
      };
      this.socket.on("message", onMessage);
    });
  }

  waitForJoined(ms = 2000): Promise<Extract<ServerMsg, { t: "joined" }>> {
    const seen = this.received.find(
      (m): m is Extract<ServerMsg, { t: "joined" }> => m.t === "joined"
    );
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off("message", onMessage);
        reject(new Error("timed out waiting for joined"));
      }, ms);
      const onMessage = (raw: WebSocket.RawData): void => {
        const msg = JSON.parse(String(raw)) as ServerMsg;
        if (msg.t === "joined") {
          clearTimeout(timer);
          this.socket.off("message", onMessage);
          resolve(msg);
        }
      };
      this.socket.on("message", onMessage);
    });
  }

  close(): void {
    this.socket.close();
  }
}

describe("byo room end-to-end", () => {
  let wss: WebSocketServer;

  before(() => {
    wss = startServer({ port: PORT, mode: "byo" });
  });

  after(async () => {
    // close() only fires its callback once every client has gone, so drop any
    // stragglers first rather than hanging the run.
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  test("two people in one room see each other's messages", async () => {
    const mira = await TestClient.connect();
    const sam = await TestClient.connect();
    mira.send({
      t: "join",
      room: "e2e-1",
      member: { handle: "mellery", displayName: "Mira" },
    });
    sam.send({
      t: "join",
      room: "e2e-1",
      member: { handle: "swhitfield", displayName: "Sam" },
    });
    // Wait for Sam's own join to be processed — "Mira joined" happened before
    // Sam connected, so it arrives in his replayed transcript, not as a live entry.
    await sam.waitForJoined();

    mira.send({ t: "say", text: "can you check the backtest?" });

    const seen = await sam.waitForEntry((e) => e.text === "can you check the backtest?");
    assert.equal(seen.kind, "human");
    assert.equal(seen.authorHandle, "mellery");

    mira.close();
    sam.close();
  });

  test("one person's two devices are both in the room, as one member", async () => {
    const laptop = await TestClient.connect();
    const desktop = await TestClient.connect();
    const sam = await TestClient.connect();
    const mira = { handle: "mellery", displayName: "Mira" };

    laptop.send({ t: "join", room: "e2e-devices", member: mira });
    await laptop.waitForJoined();
    desktop.send({ t: "join", room: "e2e-devices", member: mira });
    const second = await desktop.waitForJoined();
    sam.send({ t: "join", room: "e2e-devices", member: { handle: "swhitfield", displayName: "Sam" } });
    await sam.waitForJoined();

    // The same identity twice: the second device must not have hung up on the
    // first, which is what a 4000 in `closes` would mean.
    assert.equal(laptop.open, true);
    assert.deepEqual(laptop.closes, []);
    // And the room still describes one person rather than one entry per device.
    assert.equal(second.roster.filter((r) => r.handle === "mellery").length, 1);

    // Both machines hear the room...
    sam.send({ t: "say", text: "which of you is reading this?" });
    await laptop.waitForEntry((e) => e.text === "which of you is reading this?");
    await desktop.waitForEntry((e) => e.text === "which of you is reading this?");

    // ...and either may speak as them.
    desktop.send({ t: "say", text: "both of us" });
    const spoken = await sam.waitForEntry((e) => e.text === "both of us");
    assert.equal(spoken.authorHandle, "mellery");

    // One device closing does not take the person out of the room with it.
    desktop.close();
    sam.send({ t: "say", text: "still there?" });
    await laptop.waitForEntry((e) => e.text === "still there?");
    laptop.send({ t: "say", text: "still here" });
    const after = await sam.waitForEntry((e) => e.text === "still here");
    assert.equal(after.authorHandle, "mellery");

    laptop.close();
    sam.close();
  });

  test("a member's own agent posts back, attributed to them", async () => {
    const mira = await TestClient.connect();
    const sam = await TestClient.connect();
    const mirasAgent = await TestClient.connect();

    mira.send({ t: "join", room: "e2e-2", member: { handle: "mellery", displayName: "Mira" } });
    sam.send({ t: "join", room: "e2e-2", member: { handle: "swhitfield", displayName: "Sam" } });
    mirasAgent.send({
      t: "join",
      room: "e2e-2",
      role: "agent",
      member: { handle: "mellery", displayName: "Mira" },
    });
    await sam.waitForEntry((e) => e.text.includes("Mira's agent joined"));

    // The agent sees the room it just joined.
    sam.send({ t: "say", text: "what's the sharpe?" });
    await mirasAgent.waitForEntry((e) => e.text === "what's the sharpe?");

    mirasAgent.send({ t: "say", text: "1.42 on the latest run." });

    const seenBySam = await sam.waitForEntry((e) => e.text === "1.42 on the latest run.");
    assert.equal(seenBySam.kind, "agent");
    assert.equal(seenBySam.authorName, "Mira's agent");
    assert.equal(seenBySam.authorHandle, "mellery");

    // Mira's own editor sees his agent's reply too — one conversation, not two.
    await mira.waitForEntry((e) => e.text === "1.42 on the latest run.");

    mira.close();
    sam.close();
    mirasAgent.close();
  });

  test("a message sent in the same tick as join is not dropped", async () => {
    const sam = await TestClient.connect();
    sam.send({ t: "join", room: "e2e-race", member: { handle: "swhitfield", displayName: "Sam" } });
    await sam.waitForJoined();

    const mira = await TestClient.connect();
    // Exactly what RelayClient does on reconnect: join, then immediately flush
    // whatever was queued while offline — including tool results.
    mira.send({ t: "join", room: "e2e-race", member: { handle: "mellery", displayName: "Mira" } });
    mira.send({ t: "say", text: "queued while offline" });

    const seen = await sam.waitForEntry((e) => e.text === "queued while offline");
    assert.equal(seen.authorHandle, "mellery");

    mira.close();
    sam.close();
  });

  test("a second join on one socket is refused rather than leaving a phantom", async () => {
    const socket = await TestClient.connect();
    socket.send({ t: "join", room: "e2e-double", member: { handle: "alice", displayName: "Alice" } });
    await socket.waitForJoined();
    socket.send({ t: "join", room: "e2e-double", member: { handle: "bob", displayName: "Bob" } });

    const observer = await TestClient.connect();
    observer.send({ t: "join", room: "e2e-double", member: { handle: "obs", displayName: "Obs" } });
    const joined = await observer.waitForJoined();

    // Bob must never have been registered, so no phantom can outlive the socket.
    assert.equal(joined.roster.some((r) => r.handle === "bob"), false);

    socket.close();
    observer.close();
  });

  test("two people and four agents share one conversation", async () => {
    const mira = await TestClient.connect();
    const sam = await TestClient.connect();
    mira.send({ t: "join", room: "e2e-many", member: { handle: "mellery", displayName: "Mira" } });
    sam.send({ t: "join", room: "e2e-many", member: { handle: "swhitfield", displayName: "Sam" } });
    await sam.waitForJoined();

    // Two agents each, all under their owners' handles.
    const fleet = [
      { handle: "mellery", name: "Mira", id: "i:coder", label: "Mira's coder" },
      { handle: "mellery", name: "Mira", id: "i:reviewer", label: "Mira's reviewer" },
      { handle: "swhitfield", name: "Sam", id: "s:coder", label: "Sam's coder" },
      { handle: "swhitfield", name: "Sam", id: "s:reviewer", label: "Sam's reviewer" },
    ];
    const clients = [];
    for (const a of fleet) {
      const c = await TestClient.connect();
      c.send({
        t: "join",
        room: "e2e-many",
        role: "agent",
        agentId: a.id,
        agentLabel: a.label,
        member: { handle: a.handle, displayName: a.name },
      });
      await c.waitForJoined();
      clients.push(c);
    }

    // Every agent posts; nothing evicts anything.
    for (let i = 0; i < fleet.length; i++) {
      clients[i].send({ t: "say", text: `reporting as ${fleet[i].label}` });
    }
    for (const a of fleet) {
      const seen = await mira.waitForEntry((e) => e.text === `reporting as ${a.label}`);
      assert.equal(seen.kind, "agent");
      assert.equal(seen.authorName, a.label);
      // Each wears its owner's handle, so the room reads as one conversation.
      assert.equal(seen.authorHandle, a.handle);
      // The relay namespaces agent ids by owner, so a client's chosen id is a
      // suffix rather than the whole thing.
      assert.equal(seen.agentId, `${a.handle}::${a.id}`);
    }

    // And the roster attributes them to the right people.
    const late = await TestClient.connect();
    late.send({ t: "join", room: "e2e-many", member: { handle: "kate", displayName: "Kate" } });
    const joined = await late.waitForJoined();
    const miraEntry = joined.roster.find((r) => r.handle === "mellery");
    const samEntry = joined.roster.find((r) => r.handle === "swhitfield");
    assert.equal(miraEntry?.agents.length, 2);
    assert.equal(samEntry?.agents.length, 2);

    mira.close();
    sam.close();
    late.close();
    for (const c of clients) c.close();
  });

  test("two members whose agents share an id do not evict each other", async () => {
    // Every client defaults its first agent to the same local id. Keyed globally
    // that made each join close the other's socket, which reconnected and closed
    // back — a room filling with "agent joined" forever.
    const mira = await TestClient.connect();
    const sam = await TestClient.connect();
    mira.send({
      t: "join",
      room: "e2e-collide",
      role: "agent",
      agentId: "local:default",
      agentLabel: "Mira's agent",
      member: { handle: "mellery", displayName: "Mira" },
    });
    await mira.waitForJoined();
    sam.send({
      t: "join",
      room: "e2e-collide",
      role: "agent",
      agentId: "local:default",
      agentLabel: "Sam's agent",
      member: { handle: "swhitfield", displayName: "Sam" },
    });
    await sam.waitForJoined();

    const observer = await TestClient.connect();
    observer.send({
      t: "join",
      room: "e2e-collide",
      member: { handle: "obs", displayName: "Obs" },
    });
    const joined = await observer.waitForJoined();

    // Both agents present at once, under their own owners.
    assert.equal(joined.roster.find((r) => r.handle === "mellery")?.agents.length, 1);
    assert.equal(joined.roster.find((r) => r.handle === "swhitfield")?.agents.length, 1);
    // And their ids differ despite both clients asking for "local:default".
    const ids = joined.roster.flatMap((r) => r.agents.map((a) => a.id));
    assert.equal(new Set(ids).size, ids.length, "agent ids must be unique per owner");

    mira.close();
    sam.close();
    observer.close();
  });

  test("a joiner receives the conversation so far", async () => {
    const mira = await TestClient.connect();
    mira.send({ t: "join", room: "e2e-3", member: { handle: "mellery", displayName: "Mira" } });
    await mira.waitForEntry((e) => e.text.includes("Mira joined"));
    mira.send({ t: "say", text: "earlier decision: we use GQA" });
    await mira.waitForEntry((e) => e.text.includes("GQA"));

    const late = await TestClient.connect();
    late.send({ t: "join", room: "e2e-3", member: { handle: "kate", displayName: "Kate" } });

    const joined = await late.waitForJoined();
    assert.ok(joined.transcript.some((e) => e.text.includes("GQA")));

    mira.close();
    late.close();
  });
});
