/**
 * Who may do what, decided in the room rather than in the UI.
 *
 * A permission system enforced by the client is a suggestion — anyone can send
 * the message the button would have sent. These all go through `Room` and the
 * server, so hiding a button is presentation and nothing more.
 *
 * Worth remembering: roles only *mean* something on a relay that verifies
 * identity. Without RIPIENO_REQUIRE_GITHUB a handle is self-asserted, so a viewer
 * can rejoin as somebody else. They are still enforced, because the alternative
 * is a permission system that exists only in the interface.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { WebSocketServer } from "ws";
import type { Member, ServerMsg } from "@ripieno/protocol";
import { WORKSPACE_HANDLE } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";
import { startServer } from "../src/server.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  close(): void {
    this.readyState = 3;
  }
  systems(): string {
    return this.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .filter((m) => m.entry.kind === "system")
      .map((m) => m.entry.text)
      .join(" ");
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

describe("a room has an owner from the moment it exists", () => {
  test("the first person in owns it", async () => {
    // Nobody can be granted ownership by an owner in an empty room, so the
    // first arrival takes it — otherwise a room can never start.
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    assert.equal(room.roleOf("mellery"), "owner");
  });

  test("everyone after that is an ordinary member", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    await room.join(sam, new Socket());
    assert.equal(room.roleOf("swhitfield"), "member");
    assert.equal(room.canAct("swhitfield"), true);
  });

  test("the shared workspace never becomes the owner", async () => {
    // It joins like anyone else, but it is not a person and cannot hold a room.
    const room = new Room("r", new Driver());
    await room.join(
      { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
      new Socket(),
      "workspace"
    );
    await room.join(mira, new Socket());
    assert.equal(room.roleOf("mellery"), "owner");
    assert.equal(
      room.roster.find((r) => r.handle === WORKSPACE_HANDLE)?.role,
      undefined,
      "infrastructure holds no role"
    );
  });

  test("ownership survives a restart", async () => {
    const first = new Room("r", new Driver());
    await first.join(mira, new Socket());
    await first.join(sam, new Socket());
    first.setRole("mellery", "swhitfield", "viewer");

    const revived = new Room("r", new Driver());
    revived.hydrate(first.snapshot());
    assert.equal(revived.roleOf("mellery"), "owner");
    assert.equal(revived.roleOf("swhitfield"), "viewer");
  });

  test("a snapshot written before roles existed still loads", async () => {
    const room = new Room("r", new Driver());
    room.hydrate({ transcript: [], actions: [], members: [mira] });
    assert.equal(room.roleOf("mellery"), "member");
  });
});

describe("only the owner changes roles", () => {
  test("a member cannot promote themselves", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    const samSocket = new Socket();
    await room.join(sam, samSocket);

    room.setRole("swhitfield", "swhitfield", "owner");
    assert.equal(room.roleOf("swhitfield"), "member");
    assert.match(samSocket.systems(), /Only the room's owner/);
  });

  test("a member cannot demote the owner", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    await room.join(sam, new Socket());
    room.setRole("swhitfield", "mellery", "viewer");
    assert.equal(room.roleOf("mellery"), "owner");
  });

  test("the owner cannot demote themselves and strand the room", async () => {
    // A room whose owner demoted themselves by accident has nobody who can
    // undo it.
    const room = new Room("r", new Driver());
    const socket = new Socket();
    await room.join(mira, socket);
    room.setRole("mellery", "mellery", "viewer");
    assert.equal(room.roleOf("mellery"), "owner");
    assert.match(socket.systems(), /cannot change your own role/);
  });

  test("a refusal is told to the person who asked, not to the room", async () => {
    const room = new Room("r", new Driver());
    const miraSocket = new Socket();
    await room.join(mira, miraSocket);
    const samSocket = new Socket();
    await room.join(sam, samSocket);

    const before = miraSocket.sent.length;
    room.setRole("swhitfield", "mellery", "viewer");
    assert.equal(miraSocket.sent.length, before, "an ordinary mistake is not public");
    assert.match(samSocket.systems(), /Only the room's owner/);
  });

  test("the owner can promote and demote", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    await room.join(sam, new Socket());
    room.setRole("mellery", "swhitfield", "viewer");
    assert.equal(room.canAct("swhitfield"), false);
    room.setRole("mellery", "swhitfield", "member");
    assert.equal(room.canAct("swhitfield"), true);
  });
});

describe("a viewer watches, and that is all", () => {
  const PORT = 8919;
  const URL = `ws://localhost:${PORT}`;
  let wss: WebSocketServer;

  before(async () => {
    wss = startServer({ port: PORT, mode: "byo" });
    await new Promise((r) => setTimeout(r, 150));
  });

  after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  async function connect(payload: Record<string, unknown>): Promise<{
    ws: WebSocket;
    seen: ServerMsg[];
  }> {
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on("open", r));
    const seen: ServerMsg[] = [];
    ws.on("message", (raw: WebSocket.RawData) => seen.push(JSON.parse(String(raw)) as ServerMsg));
    ws.send(JSON.stringify({ t: "join", room: "watched", ...payload }));
    await new Promise((r) => setTimeout(r, 250));
    return { ws, seen };
  }

  test("a viewer cannot post, and is told why", async () => {
    const owner = await connect({ member: mira });
    const viewer = await connect({ member: sam });
    owner.ws.send(JSON.stringify({ t: "setRole", handle: "swhitfield", role: "viewer" }));
    await new Promise((r) => setTimeout(r, 250));

    viewer.ws.send(JSON.stringify({ t: "say", text: "can I speak?" }));
    await new Promise((r) => setTimeout(r, 250));

    const errors = viewer.seen
      .filter((m) => m.t === "error")
      .map((m) => (m as { message: string }).message)
      .join(" ");
    assert.match(errors, /viewers can read this room but not post/);

    // And nothing they said reached anyone.
    const said = owner.seen
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry.text)
      .join(" ");
    assert.ok(!said.includes("can I speak?"));

    owner.ws.terminate();
    viewer.ws.terminate();
  });

  test("a viewer cannot attach an agent at all", async () => {
    // Refused at the connection rather than per message: an agent that spawns
    // and then discovers it is mute has already cost tokens and looks broken.
    const owner = await connect({ member: mira });
    const viewer = await connect({ member: sam });
    owner.ws.send(JSON.stringify({ t: "setRole", handle: "swhitfield", role: "viewer" }));
    await new Promise((r) => setTimeout(r, 250));

    const agent = await connect({
      member: sam,
      role: "agent",
      agentId: "a1",
      agentLabel: "Sam's coder",
    });
    const errors = agent.seen
      .filter((m) => m.t === "error")
      .map((m) => (m as { message: string }).message)
      .join(" ");
    assert.match(errors, /viewers cannot attach agents/);
    assert.equal(agent.seen.some((m) => m.t === "joined"), false);

    owner.ws.terminate();
    viewer.ws.terminate();
    agent.ws.terminate();
  });

  test("a viewer still receives the room", async () => {
    // Read-only must mean read, not excluded.
    const owner = await connect({ member: mira });
    const viewer = await connect({ member: sam });
    owner.ws.send(JSON.stringify({ t: "setRole", handle: "swhitfield", role: "viewer" }));
    await new Promise((r) => setTimeout(r, 200));
    owner.ws.send(JSON.stringify({ t: "say", text: "the build is green" }));
    await new Promise((r) => setTimeout(r, 250));

    const heard = viewer.seen
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry.text)
      .join(" ");
    assert.match(heard, /the build is green/);

    owner.ws.terminate();
    viewer.ws.terminate();
  });
});
