/**
 * The timeout contract between the relay and a member's editor.
 *
 * These two clocks used to be the same 60s value, which meant a command that
 * legitimately took about a minute could never return in time even with instant
 * approval — the relay had already answered the agent with an error, the command
 * ran anyway, and its output went nowhere. The invariant below is what stops the
 * constants converging again.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMMAND_TIMEOUT_MS } from "@mpa/protocol";
import { TOOL_WINDOWS_MS } from "../src/hostedDriver.js";

describe("tool-call deadlines", () => {
  test("the running window outlasts the editor's own command timeout", () => {
    assert.ok(
      TOOL_WINDOWS_MS.running > COMMAND_TIMEOUT_MS,
      `running window (${TOOL_WINDOWS_MS.running}ms) must exceed COMMAND_TIMEOUT_MS ` +
        `(${COMMAND_TIMEOUT_MS}ms), or a command that finishes just in time still loses the race`
    );
  });

  test("waiting on a human is more patient than waiting on a machine", () => {
    // A person reading a modal should never be timed out as fast as an
    // unresponsive process.
    assert.ok(TOOL_WINDOWS_MS["awaiting-approval"] > TOOL_WINDOWS_MS.running);
    assert.ok(TOOL_WINDOWS_MS["awaiting-approval"] > TOOL_WINDOWS_MS.received);
  });

  test("an editor that never acknowledges is given up on quickly", () => {
    // This is the only window that detects an absent member, so it must be the
    // shortest — otherwise the whole room stalls on someone who has gone.
    const others = [
      TOOL_WINDOWS_MS.received,
      TOOL_WINDOWS_MS.running,
      TOOL_WINDOWS_MS["awaiting-approval"],
    ];
    assert.ok(others.every((w) => TOOL_WINDOWS_MS.dispatched < w));
  });

  test("every window is a sane duration", () => {
    for (const [state, ms] of Object.entries(TOOL_WINDOWS_MS)) {
      assert.ok(ms >= 10_000, `${state} is implausibly short`);
      assert.ok(ms <= 600_000, `${state} would hold the room too long`);
    }
  });
});
