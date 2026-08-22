import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_GOALS,
  MAX_GOAL_AUDIT_ENTRIES,
  MAX_GOAL_REQUESTS,
  MAX_GOAL_REQUEST_ID_CHARS,
  MAX_GOAL_TEXT_CHARS,
} from "../src/index.js";
import type { ClientMsg, Goal, ServerMsg } from "../src/index.js";

test("the goal wire contract is typed in both directions", () => {
  const goal: Goal = {
    id: "goal_server-minted",
    text: "Ship the multiplayer demo",
    ownerHandle: "mellery",
    ownerName: "Mira",
    status: "active",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const create: ClientMsg = { t: "goalCreate", requestId: "req_1", text: goal.text };
  const transition: ClientMsg = {
    t: "goalTransition",
    requestId: "req_2",
    goalId: goal.id,
    action: "pause",
    expectedVersion: 1,
  };
  const state: ServerMsg = { t: "goals", goals: [goal], goalAudit: [], roomRevision: 1 };
  const result: ServerMsg = {
    t: "goalResult",
    requestId: "req_1",
    ok: true,
    goal,
    roomRevision: 1,
  };
  assert.deepEqual([create.t, transition.t, state.t, result.t], [
    "goalCreate",
    "goalTransition",
    "goals",
    "goalResult",
  ]);
});

test("every durable goal collection has an explicit finite cap", () => {
  for (const bound of [
    MAX_GOALS,
    MAX_GOAL_TEXT_CHARS,
    MAX_GOAL_AUDIT_ENTRIES,
    MAX_GOAL_REQUESTS,
    MAX_GOAL_REQUEST_ID_CHARS,
  ]) {
    assert.ok(Number.isSafeInteger(bound) && bound > 0);
  }
});
