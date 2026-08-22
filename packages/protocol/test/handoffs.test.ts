import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFF_EXPIRY_MS,
  MAX_HANDOFFS,
  MAX_HANDOFF_AUDIT_ENTRIES,
  MAX_HANDOFF_CONTEXT_ACTIONS,
  MAX_HANDOFF_CONTEXT_CHARS,
  MAX_HANDOFF_CONTEXT_GOALS,
  MAX_HANDOFF_CONTEXT_TRANSCRIPT,
  MAX_HANDOFF_REQUEST_ID_CHARS,
  MAX_HANDOFF_REQUESTS,
  MAX_HANDOFF_TASK_CHARS,
  MAX_HANDOFF_OUTCOME_CHARS,
} from "../src/index.js";
import type { ClientMsg, HandoffOffer, ServerMsg } from "../src/index.js";

test("the handoff wire contract is explicit in both directions", () => {
  const offer: HandoffOffer = {
    id: "handoff_server-minted",
    nonce: "server-minted-nonce",
    task: "Review and finish the release fix.",
    sourceAgentId: "mira::coder",
    sourceAgentLabel: "Mira's coder",
    sourceOwnerHandle: "mira",
    sourceOwnerName: "Mira",
    targetHandle: "sam",
    targetName: "Sam",
    status: "pending",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
  };
  const create: ClientMsg = {
    t: "handoffOffer",
    requestId: "req_offer",
    targetHandle: "sam",
    sourceAgentId: "mira::coder",
    task: "Review and finish the release fix.",
  };
  const accept: ClientMsg = {
    t: "handoffDecision",
    requestId: "req_accept",
    handoffId: offer.id,
    nonce: offer.nonce,
    action: "accept",
    expectedVersion: 1,
    targetAgentId: "sam::reviewer",
  };
  const state: ServerMsg = {
    t: "handoffs",
    handoffs: [offer],
    handoffAudit: [],
    handoffRevision: 1,
  };
  const claim: ClientMsg = {
    t: "handoffClaim",
    handoffId: offer.id,
    deliveryId: "delivery_server-minted",
    expectedVersion: 2,
  };
  const outcome: ClientMsg = {
    t: "handoffOutcome",
    handoffId: offer.id,
    deliveryId: "delivery_server-minted",
    outcome: "completed",
  };
  assert.deepEqual([create.t, accept.t, claim.t, outcome.t, state.t], [
    "handoffOffer",
    "handoffDecision",
    "handoffClaim",
    "handoffOutcome",
    "handoffs",
  ]);
  assert.equal("providerSessionId" in offer, false);
  assert.equal("apiKey" in offer, false);
});

test("every handoff collection, lifetime and continuation section has a finite cap", () => {
  for (const bound of [
    HANDOFF_EXPIRY_MS,
    MAX_HANDOFFS,
    MAX_HANDOFF_AUDIT_ENTRIES,
    MAX_HANDOFF_REQUESTS,
    MAX_HANDOFF_REQUEST_ID_CHARS,
    MAX_HANDOFF_TASK_CHARS,
    MAX_HANDOFF_OUTCOME_CHARS,
    MAX_HANDOFF_CONTEXT_CHARS,
    MAX_HANDOFF_CONTEXT_TRANSCRIPT,
    MAX_HANDOFF_CONTEXT_ACTIONS,
    MAX_HANDOFF_CONTEXT_GOALS,
  ]) {
    assert.ok(Number.isSafeInteger(bound) && bound > 0);
  }
  assert.ok(HANDOFF_EXPIRY_MS <= 10 * 60_000, "pending consent should expire promptly");
});
