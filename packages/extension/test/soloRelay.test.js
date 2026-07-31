/**
 * A room that needs nothing set up.
 *
 * The first thing a stranger hit was infrastructure — deploy a relay, mint a
 * token, put it in settings, find a second person — and for an open-source
 * project that is the audience gone before the interesting part.
 *
 * The property worth protecting is that this is the *same* relay a team shares,
 * not a reduced imitation. Solo mode is where someone forms their opinion of the
 * product, and a cut-down version would teach them the wrong thing about it.
 */

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const WebSocket = require("ws");
const { SoloRelay } = require("../dist/soloRelay.js");

const started = [];

async function solo() {
  const relay = new SoloRelay();
  started.push(relay);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpa-solo-"));
  return { relay, url: await relay.start(dir), dir };
}

/** A member, as the relay sees one. */
async function join(url, handle, room = "alone") {
  const ws = new WebSocket(url);
  await new Promise((r) => ws.on("open", r));
  const seen = [];
  ws.on("message", (raw) => seen.push(JSON.parse(String(raw))));
  ws.send(JSON.stringify({ t: "join", room, member: { handle, displayName: handle } }));
  await new Promise((r) => setTimeout(r, 200));
  return { ws, seen };
}

after(async () => {
  for (const relay of started) await relay.stop();
});

describe("working alone needs no server and no token", () => {
  test("a room works with nothing configured", async () => {
    const { url } = await solo();
    assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/);

    const me = await join(url, "mira");
    assert.ok(
      me.seen.some((m) => m.t === "joined"),
      "joining should just work"
    );
    me.ws.terminate();
  });

  test("it binds loopback only, so nothing outside the machine can reach it", async () => {
    // Which is also why it needs no token: demanding one from a person talking
    // to their own editor would be ceremony rather than security.
    const { url } = await solo();
    assert.ok(url.includes("127.0.0.1"), url);
  });

  test("two windows on one machine do not fight over a port", async () => {
    // Port 0 means "anything free". A fixed port would make the second window
    // fail in a way that looks like the extension being broken.
    const first = await solo();
    const second = await solo();
    assert.notEqual(first.url, second.url);
  });

  test("it is the same relay, not a cut-down one", async () => {
    // The transcript, roster and provenance envelope all have to be there — a
    // simplified solo path would teach people the wrong thing about the product
    // and diverge the moment either side changed.
    const { url } = await solo();
    const me = await join(url, "mira");
    me.ws.send(JSON.stringify({ t: "say", text: "does this work?" }));
    await new Promise((r) => setTimeout(r, 200));

    const entries = me.seen.filter((m) => m.t === "entry").map((m) => m.entry);
    const mine = entries.find((e) => e.text === "does this work?");
    assert.ok(mine, "the message should come back through the room");
    assert.equal(mine.authorHandle, "mira", "attributed, exactly as with other people");
    assert.equal(mine.kind, "human");

    const joined = me.seen.find((m) => m.t === "joined");
    assert.equal(joined.mode, "byo");
    assert.equal(joined.you.role, "owner", "the only person in a room owns it");
    me.ws.terminate();
  });

  test("a second person can join the same local relay", async () => {
    // Solo is not a different product: adding somebody is a change of URL, and
    // on one machine it is not even that.
    const { url } = await solo();
    const mira = await join(url, "mira");
    const sam = await join(url, "sam");
    mira.ws.send(JSON.stringify({ t: "say", text: "hello" }));
    await new Promise((r) => setTimeout(r, 250));

    const heard = sam.seen
      .filter((m) => m.t === "entry")
      .map((m) => m.entry.text)
      .join(" ");
    assert.match(heard, /hello/);
    mira.ws.terminate();
    sam.ws.terminate();
  });

  test("history survives the window being reloaded", async () => {
    // Solo rooms persist for the same reason shared ones do: losing the
    // conversation on a reload would be the first thing anyone noticed.
    const { relay, url, dir } = await solo();
    const me = await join(url, "mira", "persisted");
    me.ws.send(JSON.stringify({ t: "say", text: "remember this" }));
    await new Promise((r) => setTimeout(r, 250));
    me.ws.terminate();
    await relay.stop();

    const again = new SoloRelay();
    started.push(again);
    const revived = await again.start(dir);
    const back = await join(revived, "mira", "persisted");
    const heard = back.seen
      .find((m) => m.t === "joined")
      .transcript.map((e) => e.text)
      .join(" ");
    assert.match(heard, /remember this/);
    back.ws.terminate();
  });

  test("starting twice returns the same relay rather than a second one", async () => {
    const { relay, url, dir } = await solo();
    assert.equal(await relay.start(dir), url);
  });

  test("stopping is safe even if it never started", async () => {
    await new SoloRelay().stop();
  });
});
