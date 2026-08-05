/**
 * What the room keeps, and what it tells an agent.
 *
 * Two quiet failures. A room that never empties grew without limit, because only
 * the persisted copy was capped — so what a joiner was sent and what a restart
 * brought back had drifted apart. And the shared workspace was described to
 * agents as a *person* whenever its socket happened to be down, which is exactly
 * when an agent most needs to be told the workspace is unreachable rather than
 * that a colleague has gone offline.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import type { Member, RosterEntry, ServerMsg } from "@mpa/protocol";
import { Room, type SocketLike } from "../src/room.js";
import { rosterPrompt } from "../src/roomCore.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "ijmh2", displayName: "Mira" };
const container: Member = { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" };

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
  joined(): Extract<ServerMsg, { t: "joined" }> {
    return this.sent.find((m): m is Extract<ServerMsg, { t: "joined" }> => m.t === "joined")!;
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

describe("the shared workspace is never mistaken for a person", () => {
  test("it stays a workspace after its socket drops", async () => {
    // `kind` used to come from live connection state while the member list
    // persisted, so a container on a reconnect backoff — or any relay restart —
    // turned it into "@workspace — OFFLINE" in the agent's system prompt.
    const room = new Room("r", new Driver());
    const workspace = new Socket();
    await room.join(container, workspace, "workspace");
    await room.join(mira, new Socket());

    assert.equal(entryFor(room.roster, WORKSPACE_HANDLE)?.kind, "workspace");

    await room.leave(WORKSPACE_HANDLE, "workspace", workspace);

    const after = entryFor(room.roster, WORKSPACE_HANDLE);
    assert.equal(after?.present, false, "it really is gone");
    assert.equal(after?.kind, "workspace", "but it is still not a person");
  });

  test("a disconnected workspace is not listed to the agent as a member", async () => {
    const room = new Room("r", new Driver());
    const workspace = new Socket();
    await room.join(container, workspace, "workspace");
    await room.join(mira, new Socket());
    await room.leave(WORKSPACE_HANDLE, "workspace", workspace);

    const prompt = rosterPrompt(room.roster);
    assert.match(prompt, /@ijmh2/);
    assert.ok(!prompt.includes(`@${WORKSPACE_HANDLE}`), `described as a member:\n${prompt}`);
  });

  test("it survives a restart as a workspace", async () => {
    const first = new Room("r", new Driver());
    const workspace = new Socket();
    await first.join(container, workspace, "workspace");
    await first.join(mira, new Socket());

    const revived = new Room("r", new Driver());
    revived.hydrate(first.snapshot());
    assert.equal(entryFor(revived.roster, WORKSPACE_HANDLE)?.kind, "workspace");
    assert.ok(!rosterPrompt(revived.roster).includes(`@${WORKSPACE_HANDLE}`));
  });
});

describe("a room that never empties does not grow without limit", () => {
  test("the transcript is capped, and a joiner is sent the cap", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 700; i++) await room.say("ijmh2", `message ${i}`);

    const joiner = new Socket();
    await room.join({ handle: "sam", displayName: "Sam" }, joiner);
    const sent = joiner.joined().transcript;

    assert.ok(sent.length <= 520, `a joiner was sent ${sent.length} entries`);
    assert.ok(
      sent.some((e) => e.text === "message 699"),
      "the newest message must be there"
    );
    assert.ok(!sent.some((e) => e.text === "message 0"), "the oldest should have aged out");
  });

  test("join and leave noise is discarded before anything anybody said", async () => {
    // Taken from the live relay. The demo room had been in use for two days and
    // held 500 entries out of a cap of 500 — every one of them a system entry,
    // 64 of which were the same agent announcing itself after a reconnect. The
    // conversation it was keeping a transcript of had been evicted by the
    // record of people arriving to have it.
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    await room.say("ijmh2", "the message that matters");

    // Churn: every connect and disconnect appends a system entry.
    for (let i = 0; i < 900; i++) {
      const socket = new Socket();
      await room.join({ handle: "sam", displayName: "Sam" }, socket);
      await room.leave("sam", "human", socket);
    }

    const joiner = new Socket();
    await room.join({ handle: "alex", displayName: "Alex" }, joiner);
    const sent = joiner.joined().transcript;

    assert.ok(
      sent.some((e) => e.text === "the message that matters"),
      `the only real message was evicted by ${sent.length} entries of noise`
    );
    assert.ok(sent.length <= 520, `still bounded: ${sent.length} entries`);
  });

  test("a room genuinely full of conversation still drops its oldest", async () => {
    // The bound is on memory, and preferring real messages must not mean
    // keeping them forever.
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 700; i++) await room.say("ijmh2", `message ${i}`);

    const joiner = new Socket();
    await room.join({ handle: "sam", displayName: "Sam" }, joiner);
    const sent = joiner.joined().transcript;

    assert.ok(sent.length <= 520, `a joiner was sent ${sent.length} entries`);
    assert.ok(sent.some((e) => e.text === "message 699"), "the newest must survive");
    assert.ok(!sent.some((e) => e.text === "message 0"), "the oldest must not");
  });

  test("the action log is capped too", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 400; i++) {
      room.recordAction({
        agentId: "a1",
        agentLabel: "Mira's coder",
        targetHandle: "ijmh2",
        verb: "wrote",
        target: `file-${i}.ts`,
        ok: true,
      });
    }
    assert.ok(room.actionLog.length <= 200, `action log held ${room.actionLog.length}`);
    assert.equal(room.actionLog.at(-1)?.target, "file-399.ts");
  });
});

describe("one member cannot fill everyone else's memory", () => {
  test("an enormous message is capped, not broadcast whole", async () => {
    // The transcript lives in memory and is rebroadcast to every member and
    // agent, so an unbounded message is everyone's problem rather than the
    // sender's. The persisted copy was capped at 1MB from the start; the wire
    // and the in-memory copy were not.
    const room = new Room("r", new Driver());
    const socket = new Socket();
    await room.join(mira, socket);
    await room.say("ijmh2", "x".repeat(500_000));

    const entry = socket.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry)
      .at(-1);
    assert.ok(entry, "it should still be delivered");
    assert.ok(entry!.text.length <= 32_000, `broadcast ${entry!.text.length} chars`);
  });

  test("an ordinary message is untouched", async () => {
    const room = new Room("r", new Driver());
    const socket = new Socket();
    await room.join(mira, socket);
    const text = "here is a stack trace\n".repeat(50);
    await room.say("ijmh2", text);
    const entry = socket.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry)
      .at(-1);
    assert.equal(entry?.text, text, "a cap that trims normal messages is a bug");
  });
});

describe("a failing driver degrades the room rather than corrupting it", () => {
  test("a member who joins is still tracked when the driver throws", async () => {
    // In hosted mode this is a live API call that can 429. It used to be the
    // last statement of join(), so the throw propagated out: the caller never
    // recorded the connection, the close handler became a no-op, and the member
    // was present forever in a room that could never be reaped.
    class Failing implements RoomDriver {
      async sendRoster(): Promise<void> {
        throw new Error("429 rate limited");
      }
      async say(): Promise<void> {}
      async resolveToolCall(): Promise<void> {}
    }

    const room = new Room("r", new Failing());
    const socket = new Socket();
    await room.join(mira, socket);

    assert.equal(entryFor(room.roster, "ijmh2")?.present, true);
    assert.equal(room.isEmpty, false);

    // And the room says so, rather than looking healthy.
    const said = socket.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry.text)
      .join(" ");
    assert.match(said, /could not be told who is in the room/);

    // Leaving still works, so the room can be reaped.
    await room.leave("ijmh2", "human", socket);
    assert.equal(room.isEmpty, true);
  });
});

function entryFor(roster: RosterEntry[], handle: string): RosterEntry | undefined {
  return roster.find((r) => r.handle === handle);
}
