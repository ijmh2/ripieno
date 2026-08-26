/** Relay-owned live response drafts: ephemeral, bounded and reconciled once. */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  closedWith?: number;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as ServerMsg);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code;
  }
  of<T extends ServerMsg["t"]>(type: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMsg, { t: T }> => message.t === type);
  }
}

class Driver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("relay-owned ephemeral response drafts", () => {
  const defaults = { ...Room.draftLimits };
  let room: Room;
  let watcher: Socket;
  let coder: Socket;

  beforeEach(async () => {
    Object.assign(Room.draftLimits, defaults, { minPublishIntervalMs: 30, ttlMs: 1_000 });
    room = new Room("drafts", new Driver());
    watcher = new Socket();
    coder = new Socket();
    await room.join(mira, watcher);
    await room.join(mira, coder, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
  });

  afterEach(async () => {
    Object.assign(Room.draftLimits, defaults);
    await room.dispose();
  });

  test("the relay mints provenance and reconciles the preview into one final entry", async () => {
    room.publishAgentDraft("mellery::coder", "It bu", 1);
    room.publishAgentDraft("mellery::coder", "ilds.", 2);
    await wait(Room.draftLimits.minPublishIntervalMs + 15);

    const deltas = watcher.of("agentDelta");
    assert.equal(deltas.map((message) => message.text).join(""), "It builds.");
    const preview = deltas[0]!;
    assert.equal(preview.agentId, "mellery::coder");
    assert.equal(preview.authorHandle, "mellery");
    assert.equal(preview.authorName, "Mira's coder");

    await room.say("mellery", "It builds.", "agent", "mellery::coder");
    const final = watcher.of("entry").filter((message) => message.entry.kind === "agent").at(-1)!.entry;
    assert.equal(final.id, preview.entryId, "the final row replaces the exact preview row");
    assert.equal(final.agentId, "mellery::coder");
    assert.equal(final.authorName, "Mira's coder");
    assert.equal(
      watcher.of("entry").filter((message) => message.entry.id === preview.entryId).length,
      1,
      "one turn creates exactly one authoritative transcript entry"
    );
    assert.equal(watcher.of("agentDeltaCancel").some((message) => message.entryId === preview.entryId), false);
  });

  test("a join snapshot carries the accumulated draft and later deltas append once", async () => {
    room.publishAgentDraft("mellery::coder", "Half", 1);
    room.publishAgentDraft("mellery::coder", " way", 2);
    const late = new Socket();
    await room.join(sam, late);
    const joined = late.of("joined").at(-1)!;
    assert.equal(joined.drafts?.length, 1);
    assert.equal(joined.drafts?.[0]?.text, "Half");

    await wait(Room.draftLimits.minPublishIntervalMs + 15);
    assert.equal(late.of("agentDelta").map((message) => message.text).join(""), " way");
    room.publishAgentDraft("mellery::coder", " there", 3);
    await wait(Room.draftLimits.minPublishIntervalMs + 15);
    const deltas = late.of("agentDelta");
    assert.equal(
      `${joined.drafts?.[0]?.text}${deltas.map((message) => message.text).join("")}`,
      "Half way there"
    );
    assert.equal(
      deltas.every((message) => message.entryId === joined.drafts?.[0]?.entryId),
      true
    );
  });

  test("out-of-order, replayed and invalid sequences are ignored", () => {
    room.publishAgentDraft("mellery::coder", "new", 5);
    const before = watcher.of("agentDelta").length;
    room.publishAgentDraft("mellery::coder", "old", 4);
    room.publishAgentDraft("mellery::coder", "replay", 5);
    room.publishAgentDraft("mellery::coder", "fraction", 5.5);
    room.publishAgentDraft("mellery::coder", "zero", 0);
    assert.equal(watcher.of("agentDelta").length, before);
    assert.equal(room.snapshot().transcript.some((entry) => entry.text.includes("old")), false);
  });

  test("bursts coalesce while the authoritative snapshot keeps every accepted byte", async () => {
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      room.publishAgentDraft("mellery::coder", String(sequence), sequence);
    }
    assert.equal(watcher.of("agentDelta").length, 1, "only the first fragment publishes immediately");
    const late = new Socket();
    await room.join(sam, late);
    assert.equal(late.of("joined").at(-1)?.drafts?.[0]?.text, "1");
    await wait(Room.draftLimits.minPublishIntervalMs + 15);
    assert.equal(watcher.of("agentDelta").length, 2, "the rest is one coalesced frame");
    assert.equal(watcher.of("agentDelta").map((message) => message.text).join(""), "12345678");
    assert.equal(late.of("agentDelta").map((message) => message.text).join(""), "2345678");
  });

  test("coalesced output frames remain UTF-8 bounded", async () => {
    Room.draftLimits.maxFrameBytes = 5;
    for (let sequence = 1; sequence <= 4; sequence += 1) {
      room.publishAgentDraft("mellery::coder", "é", sequence);
    }
    await wait(Room.draftLimits.minPublishIntervalMs * 2 + 20);
    const deltas = watcher.of("agentDelta");
    assert.equal(deltas.map((message) => message.text).join(""), "éééé");
    assert.equal(
      deltas.every((message) => Buffer.byteLength(message.text, "utf8") <= 5),
      true
    );
  });

  test("UTF-8 frame, agent and room byte caps are enforced, not character counts", async () => {
    Room.draftLimits.maxFrameBytes = 5;
    room.publishAgentDraft("mellery::coder", "ok", 1);
    const id = watcher.of("agentDelta").at(-1)?.entryId;
    room.publishAgentDraft("mellery::coder", "ééé", 2); // 3 chars, 6 bytes
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, id);

    Room.draftLimits.maxFrameBytes = defaults.maxFrameBytes;
    Room.draftLimits.maxAgentBytes = 6;
    room.publishAgentDraft("mellery::coder", "1234", 3);
    const second = watcher.of("agentDelta").at(-1)?.entryId;
    room.publishAgentDraft("mellery::coder", "789", 4);
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, second);

    Room.draftLimits.maxAgentBytes = defaults.maxAgentBytes;
    Room.draftLimits.maxRoomBytes = 6;
    const reviewer = new Socket();
    await room.join(sam, new Socket());
    await room.join(sam, reviewer, "agent", {
      id: "swhitfield::reviewer",
      label: "Sam's reviewer",
      capability: "conversation",
    });
    room.publishAgentDraft("mellery::coder", "1234", 5);
    room.publishAgentDraft("swhitfield::reviewer", "abcd", 1);
    assert.equal(
      watcher.of("agentDelta").some((message) => message.agentId === "swhitfield::reviewer"),
      false,
      "the room cap refuses a second preview rather than exceeding its active byte budget"
    );
  });

  test("agent and room frame rates cancel a preview instead of showing missing text", async () => {
    Room.draftLimits.maxAgentFramesPerSecond = 2;
    room.publishAgentDraft("mellery::coder", "one", 1);
    const id = watcher.of("agentDelta").at(-1)?.entryId;
    room.publishAgentDraft("mellery::coder", "two", 2);
    room.publishAgentDraft("mellery::coder", "three", 3);
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, id);

    await wait(1_010);
    Room.draftLimits.maxAgentFramesPerSecond = defaults.maxAgentFramesPerSecond;
    Room.draftLimits.maxRoomFramesPerSecond = 1;
    room.publishAgentDraft("mellery::coder", "fresh", 4);
    const fresh = watcher.of("agentDelta").at(-1)?.entryId;
    room.publishAgentDraft("mellery::coder", "overflow", 5);
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, fresh);
  });

  test("expiry, explicit cancel, detach and stale presence withdraw incomplete text", async () => {
    Room.draftLimits.ttlMs = 40;
    room.publishAgentDraft("mellery::coder", "stale", 1);
    const stale = watcher.of("agentDelta").at(-1)?.entryId;
    await wait(70);
    assert.equal(watcher.of("agentDeltaCancel").some((message) => message.entryId === stale), true);

    room.publishAgentDraft("mellery::coder", "cancel me", 2);
    const explicit = watcher.of("agentDelta").at(-1)?.entryId;
    room.cancelAgentDraftById("mellery::coder");
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, explicit);

    room.publishAgentDraft("mellery::coder", "detach me", 3);
    const detached = watcher.of("agentDelta").at(-1)?.entryId;
    await room.leave("mellery", "agent", coder, "mellery::coder");
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, detached);
  });

  test("an exact-agent reconnect withdraws the old socket's preview and resets ordering", async () => {
    room.publishAgentDraft("mellery::coder", "old socket", 9);
    const oldId = watcher.of("agentDelta").at(-1)?.entryId;
    const replacement = new Socket();
    await room.join(mira, replacement, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
    assert.equal(coder.closedWith, 4000);
    assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, oldId);

    room.publishAgentDraft("mellery::coder", "new socket", 1);
    const fresh = watcher.of("agentDelta").at(-1);
    assert.equal(fresh?.text, "new socket");
    assert.notEqual(fresh?.entryId, oldId);
  });

  test("a stale activity heartbeat also removes the draft", async () => {
    const presenceDefaults = { ...Room.presenceLimits };
    try {
      Room.presenceLimits.ttlMs = 30;
      room.setAgentActivity("mellery::coder", "responding", "Writing a reply", undefined, undefined, undefined, 1);
      room.publishAgentDraft("mellery::coder", "unfinished", 1);
      const id = watcher.of("agentDelta").at(-1)?.entryId;
      await wait(50);
      room.sweepStalePresence();
      assert.equal(watcher.of("agentDeltaCancel").at(-1)?.entryId, id);
    } finally {
      Object.assign(Room.presenceLimits, presenceDefaults);
    }
  });

  test("drafts are absent from persistence and a restart cannot restore them", () => {
    room.publishAgentDraft("mellery::coder", "not durable", 1);
    assert.equal(JSON.stringify(room.snapshot()).includes("not durable"), false);
  });
});
