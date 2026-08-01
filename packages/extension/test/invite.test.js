/**
 * Links that put somebody in a room.
 *
 * Every one of these arrives from outside — a browser, a chat message, a
 * forwarded email — so the parser is written to refuse rather than to cope.
 * A link is also the one place a room's shared secret travels in the open,
 * which is why the extension confirms before acting on one.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { parseInvite, buildInvite, describeInvite } = require("../dist/invite.js");

const q = (o) => new URLSearchParams(o).toString();

describe("a good link joins a room", () => {
  test("relay, room and token are read", () => {
    const r = parseInvite(q({ relay: "wss://relay.example", room: "standup", token: "s3cret" }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.invite, {
      relayUrl: "wss://relay.example",
      room: "standup",
      token: "s3cret",
    });
  });

  test("a link without a token is fine", () => {
    const r = parseInvite(q({ relay: "ws://localhost:8787", room: "demo" }));
    assert.equal(r.ok, true);
    assert.equal(r.invite.token, undefined);
  });

  test("what it builds, it can read back", () => {
    // A generator that produces something its own parser rejects is a bug
    // nobody notices until somebody else clicks the link.
    const invite = { relayUrl: "wss://relay.example", room: "a-b_c.1", token: "tok en/+=" };
    const link = buildInvite(invite, "ijmh2.multiplayer-agent");
    assert.match(link, /^vscode:\/\/ijmh2\.multiplayer-agent\/join\?/);
    const back = parseInvite(link.slice(link.indexOf("?") + 1));
    assert.equal(back.ok, true);
    assert.deepEqual(back.invite, invite);
  });
});

describe("a bad link says what is wrong instead of doing nothing", () => {
  test("missing pieces are named", () => {
    assert.match(parseInvite(q({ room: "x" })).reason, /relay address or the room code/);
    assert.match(parseInvite(q({ relay: "wss://r" })).reason, /relay address or the room code/);
    assert.match(parseInvite("").reason, /relay address or the room code/);
  });

  test("only WebSocket schemes are accepted", () => {
    // Otherwise a link could point the extension at file: or something with side
    // effects, and "click to join a room" is not read carefully by anyone.
    for (const relay of ["file:///etc/passwd", "http://relay.example", "javascript:alert(1)"]) {
      const r = parseInvite(q({ relay, room: "x" }));
      assert.equal(r.ok, false, `${relay} should be refused`);
      assert.match(r.reason, /ws:\/\/ or wss:\/\//);
    }
  });

  test("a malformed address is refused", () => {
    assert.match(parseInvite(q({ relay: "not a url", room: "x" })).reason, /not a valid address/);
  });

  test("a room code is checked before connecting", () => {
    for (const room of ["../etc", "has space", "a".repeat(65), "semi;colon"]) {
      const r = parseInvite(q({ relay: "wss://r.example", room }));
      assert.equal(r.ok, false, `"${room}" should be refused`);
      assert.match(r.reason, /not a valid room code/);
    }
  });
});

describe("people are told what they are joining", () => {
  test("the host is named, and a token is disclosed", () => {
    const withToken = describeInvite({
      relayUrl: "wss://relay.example:443",
      room: "standup",
      token: "s",
    });
    assert.match(withToken, /relay\.example/);
    assert.match(withToken, /standup/);
    assert.match(withToken, /access token/);
  });

  test("a link with no token does not claim to have one", () => {
    const plain = describeInvite({ relayUrl: "wss://relay.example", room: "standup" });
    assert.ok(!plain.includes("token"), plain);
  });
});

describe("the link uses the editor's own scheme", () => {
  test("a non-VS Code editor gets its own scheme", () => {
    // The extension runs in Antigravity and Cursor too, and each registers its
    // own. A hardcoded vscode: link silently did nothing for those users.
    const link = buildInvite(
      { relayUrl: "wss://r.example", room: "demo" },
      "ijmh2.multiplayer-agent",
      "antigravity"
    );
    assert.match(link, /^antigravity:\/\/ijmh2\.multiplayer-agent\/join\?/);
  });

  test("it still round-trips whatever the scheme", () => {
    const invite = { relayUrl: "wss://r.example", room: "demo", token: "t" };
    for (const scheme of ["vscode", "antigravity", "cursor", "vscode-insiders"]) {
      const link = buildInvite(invite, "ijmh2.multiplayer-agent", scheme);
      const back = parseInvite(link.slice(link.indexOf("?") + 1));
      assert.equal(back.ok, true, scheme);
      assert.deepEqual(back.invite, invite);
    }
  });
});
