import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_DRAFT_TTL_MS,
  MAX_AGENT_DRAFT_BYTES,
  MAX_AGENT_DRAFT_FRAME_BYTES,
  MAX_AGENT_DRAFT_FRAMES_PER_SECOND,
  MAX_ROOM_DRAFT_BYTES,
  MAX_ROOM_DRAFT_FRAMES_PER_SECOND,
  type AgentDraft,
  type ClientMsg,
  type ServerMsg,
} from "../src/index.js";

test("an agent draft frame carries ordering and text but no claimed identity", () => {
  const message: ClientMsg = { t: "agentDraft", delta: "It bu", sequence: 7 };
  assert.deepEqual(message, { t: "agentDraft", delta: "It bu", sequence: 7 });
  assert.equal(Object.keys(message).includes("agentId"), false);
  assert.equal(Object.keys(message).includes("entryId"), false);
  const cancel: ClientMsg = { t: "agentDraftCancel" };
  assert.equal(cancel.t, "agentDraftCancel");
});

test("the relay-attributed preview has enough provenance to render exactly one agent", () => {
  const draft: AgentDraft = {
    entryId: "relay-id",
    agentId: "mellery::coder",
    authorHandle: "mellery",
    authorName: "Mira's coder",
    text: "It builds.",
    updatedAt: 1,
  };
  const frame: ServerMsg = { t: "agentDelta", ...draft };
  assert.equal(frame.agentId, "mellery::coder");
  assert.equal(frame.entryId, "relay-id");
});

test("draft byte, rate and lifetime limits are explicit protocol constants", () => {
  assert.equal(MAX_AGENT_DRAFT_FRAME_BYTES, 4_096);
  assert.equal(MAX_AGENT_DRAFT_BYTES, 32_000);
  assert.equal(MAX_ROOM_DRAFT_BYTES, 128_000);
  assert.equal(MAX_AGENT_DRAFT_FRAMES_PER_SECOND, 20);
  assert.equal(MAX_ROOM_DRAFT_FRAMES_PER_SECOND, 80);
  assert.equal(AGENT_DRAFT_TTL_MS, 45_000);
});
