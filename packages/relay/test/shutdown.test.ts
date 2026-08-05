/**
 * Losing history at the moment you are trying hardest to keep it.
 *
 * Persistence is debounced by a second, and the whole design rests on a clean
 * shutdown flushing that tail. It did not: the flush was started from a `close`
 * listener without being awaited, and the process exited in the same turn. Every
 * graceful redeploy — which is every redeploy — dropped up to a second of every
 * busy room.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket = require("ws");
import type { TranscriptEntry } from "@ripieno/protocol";
import { startServer, type Relay } from "../src/server.js";
import { FileRoomStore } from "../src/roomStore.js";

const PORT = 8911;

const settle = (ms = 150): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Joins, speaks, and stays. The member must still be connected: a redeploy kills
 * rooms that are *in use*, and disconnecting would let the room be reaped —
 * which saves by another path and would test nothing.
 */
async function say(room: string, handle: string, text: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ t: "join", room, member: { handle, displayName: handle } }));
  await settle(120);
  ws.send(JSON.stringify({ t: "say", text }));
  await settle(120);
  return ws;
}

describe("a graceful shutdown keeps the history it just took", () => {
  let dir: string;
  let relay: Relay;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mpa-shutdown-"));
    relay = startServer({ port: PORT, mode: "byo", dataDir: dir });
    await settle();
  });

  after(async () => {
    for (const client of relay.clients) client.terminate();
    await new Promise((resolve) => relay.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  test("flush() persists what the debounce has not written yet", async () => {
    const member = await say("urgent", "ijmh2", "this must survive the redeploy");

    // Deliberately inside the 1s debounce window: nothing is on disk yet.
    const before: string[] = await readdir(dir).catch(() => [] as string[]);
    assert.ok(!before.includes("urgent.json"), "precondition: the debounce has not fired");

    await relay.flush();

    const snapshot = await new FileRoomStore(dir).load("urgent");
    assert.ok(snapshot, "flush must have written the room");
    assert.ok(
      snapshot!.transcript.some((e) => (e as { text?: string }).text === "this must survive the redeploy"),
      "the message taken moments before shutdown is the one most worth keeping"
    );
    member.terminate();
  });

  test("flush() is safe to call when there is nothing pending", async () => {
    await relay.flush();
    await relay.flush();
  });
});

describe("two saves of one room cannot destroy each other", () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "mpa-save-race-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("concurrent saves serialise, and the last one wins", async () => {
    // Both saves used to write `<room>.<pid>.tmp` and rename it. The loser's
    // rename failed with ENOENT into a swallowed catch, so which snapshot
    // survived was decided by rename order rather than recency — and a
    // half-written temp could be renamed into place, at which point load()
    // returns undefined and the whole history is silently gone.
    const store = new FileRoomStore(dir);
    const entry = (text: string): TranscriptEntry => ({
      id: text,
      kind: "human",
      authorHandle: "ijmh2",
      authorName: "Mira",
      text,
      ts: 0,
    });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save("busy", { transcript: [entry(`v${i}`)], actions: [], members: [] })
      )
    );

    const loaded = await store.load("busy");
    assert.ok(loaded, "the history must still be readable");
    assert.equal(loaded!.transcript.length, 1);
    assert.equal(
      (loaded!.transcript[0] as { text: string }).text,
      "v19",
      "the newest snapshot should be the one on disk"
    );

    // And no debris left behind to be mistaken for a room later.
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});
