const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
  RelayClient,
  validateRelayTransportUrl,
} = require("../dist/src/index.js");

const options = (url) => ({
  url,
  room: "test",
  member: { handle: "mira", displayName: "Mira" },
  token: "room-secret",
  githubToken: "github-secret",
  onMessage() {},
  onStateChange() {},
});

describe("the shared relay transport boundary", () => {
  test("remote plaintext and deceptive 127 hostnames are refused", () => {
    for (const url of ["ws://relay.example", "ws://10.0.0.4", "ws://127.attacker.example"]) {
      const checked = validateRelayTransportUrl(url);
      assert.equal(checked.ok, false, url);
      assert.throws(() => new RelayClient(options(url)), /must use wss:\/\//);
    }
  });

  test("loopback development and encrypted remote relays remain available", () => {
    for (const url of ["ws://127.0.0.1:8787", "ws://localhost:8787", "ws://[::1]:8787", "wss://relay.example"]) {
      assert.equal(validateRelayTransportUrl(url).ok, true, url);
      assert.doesNotThrow(() => new RelayClient(options(url)));
    }
  });
});
