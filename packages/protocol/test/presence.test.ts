import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_PRESENCE_PATH_CHARS, MAX_PRESENCE_SUMMARY_CHARS } from "../src/index.js";
import type { AgentPresence, AttachedAgent, ClientMsg } from "../src/index.js";

test("a presence frame is typed, ordered and range-capable on the wire", () => {
  const activity: ClientMsg = {
    t: "agentActivity",
    phase: "editing",
    summary: "Editing packages/relay/src/room.ts",
    path: "packages/relay/src/room.ts",
    locationScope: "shared",
    line: 700,
    endLine: 742,
    sequence: 12,
  };
  assert.equal(activity.t, "agentActivity");
  if (activity.t !== "agentActivity") return;
  assert.equal(activity.endLine, 742);
  assert.equal(activity.locationScope, "shared");
  assert.equal(activity.sequence, 12);

  // Nothing on the frame names an agent: identity is the connection's, and a
  // wire field that could carry it would be a way to claim somebody else's.
  assert.equal(Object.keys(activity).includes("agentId"), false);
  assert.equal(Object.keys(activity).includes("owner"), false);
});

test("the coarse frame stays valid without a location or a sequence", () => {
  const minimal: ClientMsg = { t: "agentActivity", phase: "thinking" };
  assert.deepEqual(minimal, { t: "agentActivity", phase: "thinking" });
});

test("presence on the roster is ephemeral and separate from the durable agent record", () => {
  const presence: AgentPresence = {
    phase: "running",
    summary: "Running a shell command",
    updatedAt: 1,
    sequence: 3,
  };
  const agent: AttachedAgent = {
    id: "mellery::coder",
    owner: "mellery",
    label: "Mira's coder",
    capability: "workspace",
    state: presence.phase,
    activity: presence,
  };
  assert.equal(agent.activity?.sequence, 3);
  // Optional throughout: an agent attached over MCP has no host to report for
  // it, and "we do not know" must never be typed away into "idle".
  const unreported: AttachedAgent = { id: "mcp", owner: "mellery", label: "MCP agent" };
  assert.equal(unreported.activity, undefined);
  assert.equal(unreported.state, undefined);
});

test("presence field bounds are stated once, for both sides of the wire", () => {
  assert.equal(MAX_PRESENCE_SUMMARY_CHARS, 240);
  assert.equal(MAX_PRESENCE_PATH_CHARS, 500);
});
