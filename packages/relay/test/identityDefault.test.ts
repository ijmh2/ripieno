/**
 * Whether a relay checks who people are, by default.
 *
 * The product's whole claim is that authorship is structure the relay
 * maintains rather than something a client asserts. It shipped with
 * verification off unless an operator set RIPIENO_REQUIRE_GITHUB=1, so what
 * anybody actually ran was the version where everyone says who they are —
 * while the README described the other one. An outside reading found it; the
 * live relay reported identityRequired:false at the time.
 *
 * The rule now: if another machine can reach it, it checks. If it is bound to
 * loopback, there is nobody else on it and a sign-in would be ceremony.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveRequireGithub } from "../src/server.js";

describe("a relay other machines can reach checks identity by default", () => {
  test("a deployed relay listens on all interfaces, so it checks", () => {
    assert.equal(resolveRequireGithub(undefined, "0.0.0.0"), true);
  });

  test("an explicit external address checks too", () => {
    assert.equal(resolveRequireGithub(undefined, "10.0.0.4"), true);
  });

  test("loopback does not, in any of its spellings", () => {
    // Solo mode. Demanding a GitHub sign-in to talk to your own laptop would
    // buy nothing and would ruin the one-minute first impression.
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      assert.equal(resolveRequireGithub(undefined, host), false, host);
    }
  });

  test("no host at all is a local default, so it does not", () => {
    assert.equal(resolveRequireGithub(undefined, undefined), false);
  });
});

describe("an operator can still say otherwise, and must say it out loud", () => {
  test("0, empty and false turn it off on a public relay", () => {
    for (const raw of ["0", "", "false", "FALSE"]) {
      assert.equal(resolveRequireGithub(raw, "0.0.0.0"), false, JSON.stringify(raw));
    }
  });

  test("1 turns it on even on loopback", () => {
    assert.equal(resolveRequireGithub("1", "127.0.0.1"), true);
  });

  test("any other value is taken as on, rather than silently as off", () => {
    // The failure to avoid: a typo in a deployment variable quietly disabling
    // the guarantee the room is advertising. Unrecognised means on.
    assert.equal(resolveRequireGithub("yes", "0.0.0.0"), true);
    assert.equal(resolveRequireGithub("true", "0.0.0.0"), true);
    assert.equal(resolveRequireGithub("2", "127.0.0.1"), true);
  });
});
