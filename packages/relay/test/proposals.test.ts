/** Relay-owned, ephemeral proposed patches. They never cross the apply boundary. */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "mira", displayName: "Mira" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  send(raw: string): void { this.sent.push(JSON.parse(raw) as ServerMsg); }
  close(): void { this.readyState = 3; }
  of<T extends ServerMsg["t"]>(type: T): Extract<ServerMsg, { t: T }>[] {
    return this.sent.filter((message): message is Extract<ServerMsg, { t: T }> => message.t === type);
  }
}

class Driver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("live proposed patches", () => {
  const defaults = { ...Room.proposalLimits };
  let room: Room;
  let watcher: Socket;

  beforeEach(async () => {
    Object.assign(Room.proposalLimits, defaults, { ttlMs: 1_000 });
    room = new Room("proposals", new Driver());
    watcher = new Socket();
    await room.join(mira, watcher);
    room.claimWorkspace("mira", true);
    await room.join(mira, new Socket(), "agent", {
      id: "mira::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
  });

  afterEach(async () => {
    Object.assign(Room.proposalLimits, defaults);
    await room.dispose();
  });

  test("relay mints exact provenance, redacts patch text, and snapshots only live state", async () => {
    room.publishAgentProposal(
      "mira::coder",
      "src/a.ts",
      "@@ -1 +1 @@\n-api_key=top-secret-value\n+api_key=still-secret-value",
      1,
      "shared"
    );
    const update = watcher.of("agentProposalUpdate").at(-1)!;
    assert.equal(update.proposal.agentId, "mira::coder");
    assert.equal(update.proposal.agentLabel, "Mira's coder");
    assert.equal(update.proposal.authorHandle, "mira");
    assert.equal(update.proposal.path, "src/a.ts");
    assert.match(update.proposal.patch, /\[REDACTED\]/);
    assert.doesNotMatch(update.proposal.patch, /top-secret|still-secret/);

    const late = new Socket();
    await room.join({ handle: "sam", displayName: "Sam" }, late);
    assert.equal(late.of("joined").at(-1)?.proposals?.[0]?.id, update.proposal.id);
    assert.equal("proposals" in room.snapshot(), false, "ephemeral patches are never persisted");
  });

  test("private, unhosted, replayed, oversized, and room-saturating proposals are refused", async () => {
    room.publishAgentProposal("mira::coder", "src/private.ts", "+secret", 1, "private");
    assert.equal(watcher.of("agentProposalUpdate").length, 0);

    room.claimWorkspace("mira", false);
    room.publishAgentProposal("mira::coder", "src/offline.ts", "+offline", 2, "shared");
    assert.equal(watcher.of("agentProposalUpdate").length, 0);
    room.claimWorkspace("mira", true);

    Room.proposalLimits.maxAgentBytes = 5;
    room.publishAgentProposal("mira::coder", "src/large.ts", "ééé", 3, "shared");
    assert.equal(watcher.of("agentProposalUpdate").length, 0, "UTF-8 bytes, not characters, enforce the cap");

    Room.proposalLimits.maxAgentBytes = defaults.maxAgentBytes;
    Room.proposalLimits.maxRoomBytes = 6;
    room.publishAgentProposal("mira::coder", "src/one.ts", "1234", 4, "shared");
    await room.join(mira, new Socket(), "agent", {
      id: "mira::reviewer",
      label: "Mira's reviewer",
      capability: "workspace",
    });
    room.publishAgentProposal("mira::reviewer", "src/two.ts", "abcd", 1, "shared");
    assert.equal(
      watcher.of("agentProposalUpdate").some((message) => message.proposal.agentId === "mira::reviewer"),
      false
    );

    room.publishAgentProposal("mira::coder", "src/replay.ts", "+old", 4, "shared");
    assert.equal(watcher.of("agentProposalUpdate").at(-1)?.proposal.path, "src/one.ts");
  });

  test("replacement, completed Work, host invalidation, and expiry resolve temporary patches", async () => {
    Room.proposalLimits.ttlMs = 30;
    room.publishAgentProposal("mira::coder", "src/a.ts", "-a\n+b", 1, "shared");
    const first = watcher.of("agentProposalUpdate").at(-1)!.proposal;
    room.publishAgentProposal("mira::coder", "src/b.ts", "-b\n+c", 2, "shared");
    assert.ok(
      watcher.of("agentProposalResolved").some((message) =>
        message.proposalId === first.id && message.reason === "replaced"
      )
    );

    const second = watcher.of("agentProposalUpdate").at(-1)!.proposal;
    room.recordAction({
      agentId: "mira::coder",
      agentLabel: "Mira's coder",
      targetHandle: "mira",
      verb: "edited",
      target: "src/b.ts",
      ok: true,
    });
    const workResolution = watcher.of("agentProposalResolved").find((message) => message.proposalId === second.id)!;
    assert.equal(workResolution.reason, "work-completed");
    assert.ok(workResolution.actionId);
    assert.equal(room.actionLog.at(-1)?.id, workResolution.actionId);

    room.publishAgentProposal("mira::coder", "src/c.ts", "+c", 3, "shared");
    room.noteWorkspaceChanged("mira", ["src/c.ts"]);
    assert.equal(watcher.of("agentProposalResolved").at(-1)?.reason, "workspace-changed");

    room.publishAgentProposal("mira::coder", "src/d.ts", "+d", 4, "shared");
    await wait(45);
    assert.equal(watcher.of("agentProposalResolved").at(-1)?.reason, "expired");
  });

  test("work on another member's same-named file cannot complete a shared proposal", () => {
    room.publishAgentProposal("mira::coder", "src/a.ts", "-a\n+b", 1, "shared");
    const proposal = watcher.of("agentProposalUpdate").at(-1)!.proposal;
    const action = {
      agentId: "mira::coder",
      agentLabel: "Mira's coder",
      targetHandle: "sam",
      verb: "edited" as const,
      target: "src/a.ts",
      ok: true,
    };
    room.recordAction(action);
    assert.equal(watcher.of("agentProposalResolved").length, 0);
    room.recordAction({ ...action, targetHandle: "mira" });
    const resolution = watcher.of("agentProposalResolved").at(-1)!;
    assert.equal(resolution.proposalId, proposal.id);
    assert.equal(resolution.reason, "work-completed");
    assert.equal(resolution.actionId, room.actionLog.at(-1)?.id);
  });

  test("a final reply cannot leave a proposal looking current", async () => {
    room.publishAgentProposal("mira::coder", "src/a.ts", "+a", 1, "shared");
    const proposal = watcher.of("agentProposalUpdate").at(-1)!.proposal;
    await room.say("mira", "Done.", "agent", "mira::coder");
    assert.ok(
      watcher.of("agentProposalResolved").some((message) =>
        message.proposalId === proposal.id && message.reason === "cancelled"
      )
    );
  });

  test("per-agent proposal rate abuse withdraws only that agent's current patch", () => {
    Room.proposalLimits.maxAgentFramesPerSecond = 2;
    room.publishAgentProposal("mira::coder", "src/a.ts", "+a", 1, "shared");
    const first = watcher.of("agentProposalUpdate").at(-1)!.proposal;
    room.publishAgentProposal("mira::coder", "src/b.ts", "+b", 2, "shared");
    room.publishAgentProposal("mira::coder", "src/c.ts", "+c", 3, "shared");
    assert.ok(
      watcher.of("agentProposalResolved").some((message) =>
        message.agentId === "mira::coder" && message.reason === "cancelled"
      )
    );
    assert.notEqual(watcher.of("agentProposalUpdate").at(-1)?.proposal.id, first.id);
    assert.equal(watcher.of("agentProposalUpdate").some((message) => message.proposal.path === "src/c.ts"), false);
  });
});
