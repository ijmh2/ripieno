const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  canUseLegacyRoomToken,
  isLoopbackHostname,
  roomTokenSecretKey,
  validateProviderBaseUrl,
  validateRelayUrl,
} = require("../dist/relaySecurity.js");

describe("relay credential transport", () => {
  test("plaintext is limited to actual loopback hosts", () => {
    for (const relay of ["ws://localhost:8787", "ws://dev.localhost:8787", "ws://127.0.0.1:8787", "ws://[::1]:8787"]) {
      assert.equal(validateRelayUrl(relay).ok, true, relay);
    }
    for (const relay of ["ws://relay.example", "ws://10.0.0.4", "ws://127.attacker.example"]) {
      const result = validateRelayUrl(relay);
      assert.equal(result.ok, false, relay);
      assert.match(result.reason, /must use wss:\/\//);
    }
    assert.equal(isLoopbackHostname("127.attacker.example"), false);
  });

  test("relay URL credentials are never accepted", () => {
    const result = validateRelayUrl("wss://user:password@relay.example");
    assert.equal(result.ok, false);
    assert.match(result.reason, /must not contain a username or password/);
  });
});

describe("provider credential transport", () => {
  test("remote API keys require HTTPS but local development can use HTTP", () => {
    assert.equal(validateProviderBaseUrl("http://127.0.0.1:11434/v1").ok, true);
    assert.equal(validateProviderBaseUrl("http://localhost:11434/v1").ok, true);
    for (const endpoint of ["http://api.example/v1", "http://127.attacker.example/v1"]) {
      const result = validateProviderBaseUrl(endpoint);
      assert.equal(result.ok, false, endpoint);
      assert.match(result.reason, /must use https:\/\//);
    }
  });

  test("provider URLs reject embedded credentials, queries and fragments", () => {
    for (const endpoint of [
      "https://user:password@api.example/v1",
      "https://api.example/v1?token=secret",
      "https://api.example/v1#fragment",
    ]) {
      assert.equal(validateProviderBaseUrl(endpoint).ok, false, endpoint);
    }
  });
});

describe("room-token origin isolation", () => {
  test("equivalent relay URLs share a key and different origins do not", () => {
    assert.equal(
      roomTokenSecretKey("wss://relay.example"),
      roomTokenSecretKey("wss://relay.example/")
    );
    assert.notEqual(
      roomTokenSecretKey("wss://relay.example"),
      roomTokenSecretKey("wss://other.example")
    );
  });

  test("a legacy global token is used only where origin ownership is known", () => {
    assert.equal(
      canUseLegacyRoomToken("wss://relay.example", "wss://relay.example/", false),
      true
    );
    assert.equal(
      canUseLegacyRoomToken("wss://old.example", "wss://new.example", true),
      false
    );
    assert.equal(canUseLegacyRoomToken(undefined, "wss://first.example", true), true);
    assert.equal(canUseLegacyRoomToken(undefined, "wss://first.example", false), false);
  });
});
