/**
 * The reserved workspace handle.
 *
 * A connection holding it is trusted to say what every file in the room's
 * repository contains — every agent's view of the code comes from whatever it
 * answers. So it is gated by its own secret rather than the room token, which
 * everybody in the room holds. Without that separation any member could join as
 * the workspace and quietly feed the whole room a different codebase than the
 * real one, and nothing in the transcript would look wrong.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { WebSocketServer } from "ws";
import type { ClientMsg, ServerMsg } from "@mpa/protocol";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import { startServer } from "../src/server.js";
import { rosterPrompt, toRosterEntry } from "../src/roomCore.js";

const PORT = 8903;
const URL = `ws://localhost:${PORT}`;
const ROOM_TOKEN = "room-token";
const WORKSPACE_TOKEN = "workspace-token";

class Client {
  readonly received: ServerMsg[] = [];
  closed?: { code: number };

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw: WebSocket.RawData) =>
      this.received.push(JSON.parse(String(raw)) as ServerMsg)
    );
    socket.on("close", (code: number) => (this.closed = { code }));
  }

  static async connect(): Promise<Client> {
    const socket = new WebSocket(URL);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return new Client(socket);
  }

  send(msg: ClientMsg): void {
    this.socket.send(JSON.stringify(msg));
  }

  errors(): string[] {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "error" }> => m.t === "error")
      .map((m) => m.message);
  }

  systems(): string[] {
    return this.received
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .filter((m) => m.entry.kind === "system")
      .map((m) => m.entry.text);
  }

  joined(): Extract<ServerMsg, { t: "joined" }> | undefined {
    return this.received.find((m): m is Extract<ServerMsg, { t: "joined" }> => m.t === "joined");
  }

  close(): void {
    this.socket.terminate();
  }
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

describe("only the container may be the workspace", () => {
  let wss: WebSocketServer;
  const open: Client[] = [];

  before(async () => {
    wss = startServer({
      port: PORT,
      mode: "byo",
      token: ROOM_TOKEN,
      workspaceToken: WORKSPACE_TOKEN,
    });
    await settle(150);
  });

  after(async () => {
    for (const c of open) c.close();
    // close() waits on clients, so they are terminated first. This has hung the
    // suite twice before.
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  const connect = async (): Promise<Client> => {
    const c = await Client.connect();
    open.push(c);
    return c;
  };

  test("a member holding the room token cannot claim the workspace handle", async () => {
    const impostor = await connect();
    impostor.send({
      t: "join",
      room: "r1",
      member: { handle: WORKSPACE_HANDLE, displayName: "Definitely The Workspace" },
      token: ROOM_TOKEN,
    });
    await settle();
    assert.match(impostor.errors().join(" "), /reserved handle/);
    assert.equal(impostor.joined(), undefined, "the join must not succeed");
    assert.equal(impostor.closed?.code, 4003);
  });

  test("the room token is not enough to join as the workspace", async () => {
    const impostor = await connect();
    impostor.send({
      t: "join",
      room: "r2",
      member: { handle: "ijmh2", displayName: "Mira" },
      role: "workspace",
      token: ROOM_TOKEN,
      workspaceToken: "guessed",
    });
    await settle();
    assert.match(impostor.errors().join(" "), /workspace token/);
    assert.equal(impostor.closed?.code, 4003);
  });

  test("the container's own token gets it the reserved identity, whatever it asked for", async () => {
    const container = await connect();
    container.send({
      t: "join",
      room: "r3",
      // Deliberately claiming to be someone else: the relay assigns the handle,
      // it never takes it from the client.
      member: { handle: "ijmh2", displayName: "Mira" },
      role: "workspace",
      token: ROOM_TOKEN,
      workspaceToken: WORKSPACE_TOKEN,
    });
    await settle();
    const joined = container.joined();
    assert.ok(joined, "the container should be let in");
    assert.equal(joined?.you.handle, WORKSPACE_HANDLE);
    assert.equal(joined?.you.kind, "workspace");
  });

  test("a container outranks a laptop, and the member is told why", async () => {
    const member = await connect();
    member.send({
      t: "join",
      room: "r4",
      member: { handle: "ijmh2", displayName: "Mira" },
      token: ROOM_TOKEN,
    });
    await settle();
    member.send({ t: "claimWorkspace", claim: true });
    await settle();

    const container = await connect();
    container.send({
      t: "join",
      room: "r4",
      member: { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
      role: "workspace",
      token: ROOM_TOKEN,
      workspaceToken: WORKSPACE_TOKEN,
    });
    await settle();
    container.send({ t: "claimWorkspace", claim: true });
    await settle();

    const roster = member.received.filter(
      (m): m is Extract<ServerMsg, { t: "roster" }> => m.t === "roster"
    );
    assert.equal(
      roster.at(-1)?.workspaceHost,
      WORKSPACE_HANDLE,
      "the durable host should take the claim from the laptop"
    );

    // And a member trying to take it back is refused with a reason, not silence.
    member.send({ t: "claimWorkspace", claim: true });
    await settle();
    assert.match(member.systems().join(" "), /stays hosted when everyone disconnects/);
  });

  test("the workspace leaving releases the claim rather than stranding agents", async () => {
    const member = await connect();
    member.send({
      t: "join",
      room: "r5",
      member: { handle: "ijmh2", displayName: "Mira" },
      token: ROOM_TOKEN,
    });
    const container = await connect();
    container.send({
      t: "join",
      room: "r5",
      member: { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
      role: "workspace",
      token: ROOM_TOKEN,
      workspaceToken: WORKSPACE_TOKEN,
    });
    await settle();
    container.send({ t: "claimWorkspace", claim: true });
    await settle();

    container.close();
    await settle(400);

    const roster = member.received.filter(
      (m): m is Extract<ServerMsg, { t: "roster" }> => m.t === "roster"
    );
    assert.equal(roster.at(-1)?.workspaceHost, undefined);
    assert.match(member.systems().join(" "), /The shared workspace left/);
  });
});

describe("the container is not described to the agent as a person", () => {
  test("the roster prompt lists people only", () => {
    // Listing it as a member invites the agent to address it as one, and to
    // attribute work to "workspace" rather than to the agent that did it.
    const prompt = rosterPrompt([
      toRosterEntry({ handle: "ijmh2", displayName: "Mira" }, true),
      toRosterEntry(
        { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
        true,
        [],
        "workspace"
      ),
    ]);
    assert.match(prompt, /@ijmh2/);
    assert.ok(!prompt.includes("@workspace"), "the container is reached with the room target");
  });

  test("a room of nothing but a container has no members", () => {
    const prompt = rosterPrompt([
      toRosterEntry(
        { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" },
        true,
        [],
        "workspace"
      ),
    ]);
    assert.match(prompt, /no members/);
  });
});
