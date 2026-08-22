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
import type { Goal, HandoffOffer, Member, RosterEntry, TranscriptEntry } from "@ripieno/protocol";
import { MAX_GOAL_AUDIT_ENTRIES, MAX_GOAL_REQUESTS } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";
import { FileRoomStore, MemoryRoomStore } from "../src/roomStore.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
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
  joined(): {
    transcript: unknown[];
    actions?: unknown[];
    goals?: Goal[];
    roomRevision?: number;
    handoffs?: HandoffOffer[];
    handoffRevision?: number;
    roster: RosterEntry[];
  } {
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
    await first.say("mellery", "the sharpe is 1.42");
    first.recordAction({
      agentId: "s:1",
      agentLabel: "Sam's agent",
      targetHandle: "mellery",
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

  test("goals, audit, revision and idempotency survive restart", async () => {
    const store = new FileRoomStore(dir);
    const first = new Room("durable-goals", new Driver());
    await first.join(mira, new Socket());
    const created = first.createGoal("mellery", "req_create", "Ship multiplayer goals");
    const goalId = created.goal!.id;
    first.transitionGoal("mellery", "req_pause", goalId, "pause", 1);
    await store.save("durable-goals", first.snapshot());

    const revived = new Room("durable-goals", new Driver());
    revived.hydrate((await store.load("durable-goals"))!);
    const socket = new Socket();
    await revived.join(mira, socket);
    assert.equal(socket.joined().goals?.[0]?.status, "paused");
    assert.equal(socket.joined().goals?.[0]?.version, 2);
    assert.equal(socket.joined().roomRevision, 2);
    assert.equal(revived.goalAuditLog.length, 2);

    const replay = revived.createGoal("mellery", "req_create", "Ship multiplayer goals");
    assert.equal(replay.goal?.id, goalId, "a retry after restart must not create a second goal");
    assert.equal(replay.goal?.status, "paused", "replay must use current authoritative state");
    assert.equal(replay.goal?.version, 2);
    assert.equal(revived.goalList.length, 1);
    const conflict = revived.createGoal("mellery", "req_create", "A different goal");
    assert.equal(conflict.ok, false);
    assert.match(conflict.message ?? "", /already used/);
  });

  test("pending handoffs, audit, revision and idempotency survive restart", async () => {
    const store = new FileRoomStore(dir);
    const first = new Room("durable-handoffs", new Driver());
    const miraHuman = new Socket();
    const samHuman = new Socket();
    await first.join(mira, miraHuman);
    await first.join(sam, samHuman);
    await first.join(mira, new Socket(), "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
    });
    const created = first.createHandoff(
      "mellery",
      "req_handoff_create",
      "swhitfield",
      "mellery::coder",
      "Finish the persisted launch task"
    );
    await store.save("durable-handoffs", first.snapshot());

    const revived = new Room("durable-handoffs", new Driver());
    revived.hydrate((await store.load("durable-handoffs"))!);
    const joinedSocket = new Socket();
    await revived.join(sam, joinedSocket);
    assert.equal(joinedSocket.joined().handoffs?.[0]?.id, created.handoff?.id);
    assert.equal(joinedSocket.joined().handoffs?.[0]?.status, "pending");
    assert.equal(joinedSocket.joined().handoffRevision, 1);
    assert.equal(revived.handoffAuditLog.length, 1);

    const replay = revived.createHandoff(
      "mellery",
      "req_handoff_create",
      "swhitfield",
      "mellery::coder",
      "Finish the persisted launch task"
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.handoff?.id, created.handoff?.id);
    assert.equal(revived.handoffList.length, 1);
    const conflict = revived.createHandoff(
      "mellery",
      "req_handoff_create",
      "someone-else",
      "mellery::coder",
      "Finish the persisted launch task"
    );
    assert.equal(conflict.ok, false);
    assert.match(conflict.message ?? "", /already used/);
  });

  test("persisted goal audit and idempotency receipts are explicitly capped", async () => {
    const store = new FileRoomStore(dir);
    const room = new Room("bounded-goals", new Driver());
    await room.join(mira, new Socket());
    const goal = room.createGoal("mellery", "req_create", "Alternate state").goal!;
    let version = 1;
    for (let i = 0; i < MAX_GOAL_AUDIT_ENTRIES + 20; i++) {
      const action = i % 2 === 0 ? "pause" : "resume";
      const result = room.transitionGoal("mellery", `req_${i}`, goal.id, action, version);
      assert.equal(result.ok, true);
      version += 1;
    }
    await store.save("bounded-goals", room.snapshot());
    const loaded = await store.load("bounded-goals");
    assert.equal(loaded?.goalAudit?.length, MAX_GOAL_AUDIT_ENTRIES);
    assert.equal(loaded?.goalRequests?.length, MAX_GOAL_REQUESTS);
    assert.ok(loaded?.goalRequests?.every((receipt) => receipt.fingerprint.length === 64));
  });

  test("the in-memory store survives room reaping without sharing mutable references", async () => {
    const store = new MemoryRoomStore();
    const first = new Room("memory-goals", new Driver());
    await first.join(mira, new Socket());
    const goal = first.createGoal("mellery", "req_memory", "Survive an empty room").goal!;
    await store.save("memory-goals", first.snapshot());

    // Mutating the live room after save must not mutate the stored snapshot.
    first.transitionGoal("mellery", "req_memory_pause", goal.id, "pause", 1);
    const stored = await store.load("memory-goals");
    assert.equal(stored?.goals?.[0]?.status, "active");

    const revived = new Room("memory-goals", new Driver());
    revived.hydrate(stored!);
    const socket = new Socket();
    await revived.join(mira, socket);
    assert.equal(socket.joined().goals?.[0]?.id, goal.id);
    assert.equal(socket.joined().roomRevision, 1);
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

    const entry = revived.roster.find((r) => r.handle === "mellery");
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
    for (let i = 0; i < 50; i++) await room.say("mellery", "x".repeat(200_000));
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
          authorHandle: "mellery",
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
      authorHandle: "mellery",
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
