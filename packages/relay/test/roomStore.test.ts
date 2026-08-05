/**
 * Room history surviving a restart.
 *
 * This was deferred for a long time and cost real time: every relay restart and
 * every redeploy emptied every room, and people rejoined a blank transcript with
 * no explanation. The tests below cover the two ways persistence goes
 * embarrassingly wrong — losing the history it was meant to keep, and restoring
 * *presence*, which would have the agent addressing tools to machines that are
 * not connected.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Member, RosterEntry, TranscriptEntry } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";
import { FileRoomStore } from "../src/roomStore.js";

const mira: Member = { handle: "ijmh2", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  joined(): { transcript: unknown[]; actions?: unknown[]; roster: RosterEntry[] } {
    return JSON.parse(this.sent.find((m) => m.includes('"joined"')) ?? "{}");
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

describe("room history survives a restart", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mpa-store-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("what was said comes back", async () => {
    const store = new FileRoomStore(dir);
    const first = new Room("demo", new Driver());
    await first.join(mira, new Socket());
    await first.say("ijmh2", "the sharpe is 1.42");
    first.recordAction({
      agentId: "s:1",
      agentLabel: "Sam's agent",
      targetHandle: "ijmh2",
      verb: "wrote",
      target: "src/a.ts",
      ok: true,
    });
    await store.save("demo", first.snapshot());

    // A restart: brand new Room object, same code.
    const revived = new Room("demo", new Driver());
    const snapshot = await store.load("demo");
    assert.ok(snapshot, "a saved room must load");
    revived.hydrate(snapshot);

    const socket = new Socket();
    await revived.join(sam, socket);
    const joined = socket.joined();
    assert.ok(
      joined.transcript.some((e) => (e as { text: string }).text === "the sharpe is 1.42"),
      "the conversation should be there"
    );
    assert.equal(joined.actions?.length, 1, "and so should the work");
  });

  test("restored members are absent until they reconnect", async () => {
    // The dangerous failure: a snapshot says who has *been* here, never who is
    // here now. Marking them present would have the agent addressing workspace
    // tools to machines that are not connected.
    const store = new FileRoomStore(dir);
    const first = new Room("presence", new Driver());
    await first.join(mira, new Socket());
    await store.save("presence", first.snapshot());

    const revived = new Room("presence", new Driver());
    revived.hydrate((await store.load("presence"))!);

    const entry = revived.roster.find((r) => r.handle === "ijmh2");
    assert.ok(entry, "the member should still be known");
    assert.equal(entry?.present, false, "but not present");
    assert.equal(entry?.agents.length, 0, "and their agents are gone with the process");
  });

  test("a restored agent message cannot be resurrected by a late delta", async () => {
    const store = new FileRoomStore(dir);
    const first = new Room("deltas", new Driver());
    await first.join(mira, new Socket());
    first.onAgentMessage("sevt_1", "final answer");
    await store.save("deltas", first.snapshot());

    const revived = new Room("deltas", new Driver());
    revived.hydrate((await store.load("deltas"))!);
    const socket = new Socket();
    await revived.join(mira, socket);

    const before = socket.sent.length;
    revived.onAgentDelta("sevt_1", "stale fragment");
    assert.equal(socket.sent.length, before, "a completed message must stay completed");
  });

  test("a room full of large messages does not become a large file", async () => {
    // The save rewrites the whole snapshot on every debounce tick, so the file
    // size is a recurring cost, not a one-off. Capping entries alone let a
    // benchmark produce a 9.8MB file.
    const store = new FileRoomStore(dir);
    const room = new Room("big", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 50; i++) await room.say("ijmh2", "x".repeat(200_000));
    await store.save("big", room.snapshot());

    const { size } = await stat(path.join(dir, "big.json"));
    assert.ok(size < 1_100_000, `snapshot should stay near the budget, was ${size} bytes`);

    const loaded = await store.load("big");
    assert.ok(loaded!.transcript.length > 0, "and it must still restore something");
  });

  test("one message bigger than the whole budget is truncated, not dropped", async () => {
    // Built directly rather than through say(), which now caps a message at
    // 32k chars. The store still has to cope: a snapshot written before that cap
    // existed can contain an entry this large, and refusing to load it would
    // lose the room's whole history rather than one message.
    const store = new FileRoomStore(dir);
    await store.save("huge", {
      transcript: [
        {
          id: "big",
          kind: "human",
          authorHandle: "ijmh2",
          authorName: "Mira",
          text: "y".repeat(3_000_000),
          ts: 0,
        },
      ],
      actions: [],
      members: [mira],
    });

    const loaded = await store.load("huge");
    assert.equal(loaded!.transcript.length, 1, "the room should not restore empty");
    assert.ok(
      (loaded!.transcript[0] as { text: string }).text.includes("truncated"),
      "and it should say so rather than pretend that was the message"
    );
  });

  test("an unknown room is simply new, not an error", async () => {
    const store = new FileRoomStore(dir);
    assert.equal(await store.load("never-existed"), undefined);
  });

  test("a corrupt file does not stop the room existing", async () => {
    // Losing history is bad; refusing to open the room is worse.
    const store = new FileRoomStore(dir);
    await writeFile(path.join(dir, "broken.json"), "{ not json", "utf8");
    assert.equal(await store.load("broken"), undefined);
  });

  test("codes that sanitise to the same name keep separate histories", async () => {
    // "a/b", "a b" and "a_b" all flattened to a_b.json, so three distinct rooms
    // shared one file — reading each other's transcript on restore and
    // overwriting it on save.
    const store = new FileRoomStore(dir);
    const entry = (text: string): TranscriptEntry => ({
      id: text,
      kind: "human",
      authorHandle: "ijmh2",
      authorName: "Mira",
      text,
      ts: 0,
    });

    for (const code of ["a/b", "a b", "a_b"]) {
      await store.save(code, { transcript: [entry(`from ${code}`)], actions: [], members: [] });
    }
    for (const code of ["a/b", "a b", "a_b"]) {
      const loaded = await store.load(code);
      assert.equal(
        (loaded?.transcript[0] as { text: string } | undefined)?.text,
        `from ${code}`,
        `room "${code}" was reading another room's history`
      );
    }
  });

  test("an ordinary code keeps its plain filename", async () => {
    // Existing history must not be orphaned by the collision fix.
    const store = new FileRoomStore(dir);
    await store.save("standup", { transcript: [], actions: [], members: [] });
    const { access } = await import("node:fs/promises");
    await access(path.join(dir, "standup.json"));
  });

  test("a room code cannot escape the data directory", async () => {
    // Codes come from clients and become filenames.
    const store = new FileRoomStore(dir);
    await store.save("../../etc/passwd", {
      transcript: [],
      actions: [],
      members: [],
    });
    const loaded = await store.load("../../etc/passwd");
    assert.ok(loaded, "it should still round-trip, just safely inside the directory");
  });
});
