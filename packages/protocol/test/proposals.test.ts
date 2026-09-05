import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_PROPOSAL_TTL_MS,
  MAX_AGENT_PROPOSAL_PATCH_BYTES,
  MAX_AGENT_PROPOSALS_PER_SECOND,
  MAX_ROOM_PROPOSAL_PATCH_BYTES,
  MAX_ROOM_PROPOSALS_PER_SECOND,
  type AgentProposal,
  type ClientMsg,
  type ServerMsg,
} from "../src/index.js";

test("proposal wire types keep identity relay-owned and scope shared", () => {
  const publish: ClientMsg = {
    t: "agentProposal",
    path: "src/room.ts",
    locationScope: "shared",
    patch: "@@ -1 +1 @@\n-old\n+new",
    sequence: 3,
  };
  const cancel: ClientMsg = { t: "agentProposalCancel" };
  const proposal: AgentProposal = {
    id: "relay-id",
    agentId: "mira::coder",
    agentLabel: "Mira's coder",
    authorHandle: "mira",
    path: "src/room.ts",
    locationScope: "shared",
    patch: publish.patch,
    updatedAt: 1,
  };
  const update: ServerMsg = { t: "agentProposalUpdate", proposal };
  const resolved: ServerMsg = {
    t: "agentProposalResolved",
    proposalId: proposal.id,
    agentId: proposal.agentId,
    reason: "work-completed",
    actionId: "work-id",
  };

  assert.equal(publish.t, "agentProposal");
  assert.equal(cancel.t, "agentProposalCancel");
  assert.equal(update.proposal.agentId, "mira::coder");
  assert.equal(resolved.actionId, "work-id");
  assert.ok(MAX_AGENT_PROPOSAL_PATCH_BYTES > 0);
  assert.ok(MAX_ROOM_PROPOSAL_PATCH_BYTES >= MAX_AGENT_PROPOSAL_PATCH_BYTES);
  assert.ok(MAX_AGENT_PROPOSALS_PER_SECOND > 0);
  assert.ok(MAX_ROOM_PROPOSALS_PER_SECOND >= MAX_AGENT_PROPOSALS_PER_SECOND);
  assert.ok(AGENT_PROPOSAL_TTL_MS > 0);
});
