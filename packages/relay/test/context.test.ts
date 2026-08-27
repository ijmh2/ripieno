import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as ServerMsg);
  }
  close(): void {
    this.readyState = 3;
  }
}

class Driver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

describe("relay-authoritative shared context", () => {
  let room: Room;
  let miraSocket: Socket;
  let samSocket: Socket;

  beforeEach(async () => {
    room = new Room("context", new Driver());
    miraSocket = new Socket();
    samSocket = new Socket();
    await room.join(mira, miraSocket);
    await room.join(sam, samSocket);
  });

  test("human additions are accepted, attributed and broadcast", () => {
    const result = room.createContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_create",
      "decision",
      "  Use structured context  ",
      "Keep provenance and versions.",
      ["architecture"]
    );
    assert.equal(result.ok, true);
    assert.match(result.item!.id, /^context_[0-9a-f-]{36}$/);
    assert.equal(result.item!.status, "accepted");
    assert.equal(result.item!.authorHandle, "swhitfield");
    assert.equal(result.item!.authorAgentId, undefined);
    assert.equal(result.item!.title, "Use structured context");
    assert.equal(result.contextRevision, 1);
    assert.equal(miraSocket.sent.at(-1)?.t, "context");
  });

  test("reclaiming a full room drops the item but keeps its audit trail", () => {
    const actor = { handle: "swhitfield", role: "human" as const };
    // One item that can be reclaimed, retired so it is a legitimate candidate.
    const doomed = room.createContext(actor, "ctxreq_doomed", "note", "Doomed", "b");
    room.updateContext(actor, "ctxreq_retire", doomed.item!.id, 1, { status: "archived" });
    const auditBefore = room.contextAuditLog.filter((e) => e.contextId === doomed.item!.id);
    assert.equal(auditBefore.length, 2, "create and archive were both recorded");

    // Fill to the cap so the next create must reclaim.
    for (let index = room.contextList.length; index < 200; index++) {
      const filled = room.createContext(actor, `ctxreq_fill_${index}`, "note", `Fill ${index}`, "b");
      assert.equal(filled.ok, true);
    }
    const forced = room.createContext(actor, "ctxreq_forced", "note", "Forced", "b");
    assert.equal(forced.ok, true, "the terminal item made room for this one");

    assert.equal(
      room.contextList.some((item) => item.id === doomed.item!.id),
      false,
      "the reclaimed item is gone"
    );
    assert.deepEqual(
      room.contextAuditLog.filter((e) => e.contextId === doomed.item!.id).map((e) => e.action),
      ["create", "archive"],
      "who wrote and who retired it survives the reclaim"
    );
  });

  test("a retry of a reclaimed item's create does not mint a second item", () => {
    const actor = { handle: "swhitfield", role: "human" as const };
    const first = room.createContext(actor, "ctxreq_once", "note", "Once", "b");
    room.updateContext(actor, "ctxreq_retire2", first.item!.id, 1, { status: "archived" });
    for (let index = room.contextList.length; index < 200; index++) {
      room.createContext(actor, `ctxreq_pad_${index}`, "note", `Pad ${index}`, "b");
    }
    room.createContext(actor, "ctxreq_evict", "note", "Evict", "b");
    const before = room.contextList.length;
    // The original request id, replayed exactly as a reconnecting client would.
    const replay = room.createContext(actor, "ctxreq_once", "note", "Once", "b");
    assert.equal(replay.ok, true);
    assert.equal(room.contextList.length, before, "the receipt still suppresses a duplicate");
  });

  test("agent additions are proposals with exact agent provenance", async () => {
    const agentSocket = new Socket();
    await room.join(mira, agentSocket, "agent", {
      id: "mellery::reviewer",
      label: "Mira's reviewer",
      capability: "workspace",
    });
    const result = room.createContext(
      {
        handle: "mellery",
        role: "agent",
        agentId: "mellery::reviewer",
        agentLabel: "Mira's reviewer",
      },
      "ctxreq_agent",
      "fact",
      "Tests are green",
      "The relay suite passed locally."
    );
    assert.equal(result.ok, true);
    assert.equal(result.item?.status, "proposed");
    assert.equal(result.item?.authorAgentId, "mellery::reviewer");
    assert.equal(result.item?.authorAgentLabel, "Mira's reviewer");

    const accepted = room.updateContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_accept",
      result.item!.id,
      1,
      { status: "accepted" }
    );
    assert.equal(accepted.ok, true);
    assert.equal(accepted.item?.status, "accepted");
    assert.equal(accepted.item?.version, 2);
    assert.equal(room.contextAuditLog.at(-1)?.actorHandle, "swhitfield");
  });

  test("agents cannot canonise context or edit another agent's proposal", async () => {
    const firstSocket = new Socket();
    const secondSocket = new Socket();
    await room.join(mira, firstSocket, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
    await room.join(sam, secondSocket, "agent", {
      id: "swhitfield::reviewer",
      label: "Sam's reviewer",
      capability: "workspace",
    });
    const item = room.createContext(
      { handle: "mellery", role: "agent", agentId: "mellery::coder", agentLabel: "Mira's coder" },
      "ctxreq_propose",
      "note",
      "Working note",
      "Still checking."
    ).item!;
    const other = room.updateContext(
      {
        handle: "swhitfield",
        role: "agent",
        agentId: "swhitfield::reviewer",
        agentLabel: "Sam's reviewer",
      },
      "ctxreq_other",
      item.id,
      1,
      { body: "Claimed by another agent." }
    );
    assert.equal(other.ok, false);
    assert.match(other.message ?? "", /only its own proposed context/i);

    const canonise = room.updateContext(
      { handle: "mellery", role: "agent", agentId: "mellery::coder", agentLabel: "Mira's coder" },
      "ctxreq_canonise",
      item.id,
      1,
      { status: "accepted" }
    );
    assert.equal(canonise.ok, false);
    assert.match(canonise.message ?? "", /person must accept/i);
  });

  test("updates are optimistic and cannot combine edits with acceptance", () => {
    const item = room.createContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_create",
      "constraint",
      "Stay bounded",
      "Do not grow prompts indefinitely."
    ).item!;
    const edited = room.updateContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_edit",
      item.id,
      1,
      { body: "Inject a bounded summary and fetch details on demand." }
    );
    assert.equal(edited.ok, true);
    assert.equal(edited.item?.version, 2);

    const stale = room.updateContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_stale",
      item.id,
      1,
      { body: "Lost update" }
    );
    assert.equal(stale.ok, false);
    assert.match(stale.message ?? "", /current version 2/);

    const combined = room.updateContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_combined",
      item.id,
      2,
      { body: "Hidden edit", status: "archived" }
    );
    assert.equal(combined.ok, false);
    assert.match(combined.message ?? "", /not both/);
  });

  test("idempotent retries replay without duplicating context", () => {
    const actor = { handle: "swhitfield", role: "human" as const };
    const first = room.createContext(actor, "ctxreq_once", "fact", "One fact", "One body");
    const replay = room.createContext(actor, "ctxreq_once", "fact", "One fact", "One body");
    assert.equal(replay.item?.id, first.item?.id);
    assert.equal(room.contextList.length, 1);
    const conflict = room.createContext(actor, "ctxreq_once", "fact", "Different", "One body");
    assert.equal(conflict.ok, false);
    assert.match(conflict.message ?? "", /already used/);
  });

  test("common credential shapes are redacted before context is shared", () => {
    const created = room.createContext(
      { handle: "swhitfield", role: "human" },
      "ctxreq_redacted",
      "reference",
      "API key: sk-secretvalue123456",
      "Authorization: Bearer room-token-that-must-not-leak",
      ["secret=visiblevalue123"]
    );
    assert.equal(created.ok, true);
    assert.doesNotMatch(JSON.stringify(created.item), /secretvalue|must-not-leak|visiblevalue/);
    assert.match(created.item?.title ?? "", /\[REDACTED\]/);
    assert.match(created.item?.body ?? "", /\[REDACTED\]/);
    assert.match(created.item?.tags[0] ?? "", /\[REDACTED\]/);
  });

  test("joined snapshots include shared context", async () => {
    const item = room.createContext(
      { handle: "mellery", role: "human" },
      "ctxreq_snapshot",
      "reference",
      "Protocol",
      "packages/protocol/src/index.ts"
    ).item!;
    const late = new Socket();
    await room.join({ handle: "kate", displayName: "Kate" }, late);
    const joined = late.sent.find(
      (message): message is Extract<ServerMsg, { t: "joined" }> => message.t === "joined"
    );
    assert.equal(joined?.context?.[0]?.id, item.id);
    assert.equal(joined?.contextRevision, 1);
    assert.equal(joined?.contextAudit?.length, 1);
  });

  test("context and retry receipts survive a relay room restart", async () => {
    const actor = { handle: "mellery", role: "human" as const };
    const created = room.createContext(
      actor,
      "ctxreq_durable",
      "decision",
      "Persist context",
      "Room memory survives relay reaping and restart."
    );
    const revived = new Room("context", new Driver());
    revived.hydrate(room.snapshot());
    const socket = new Socket();
    await revived.join(mira, socket);
    assert.equal(revived.contextList[0]?.id, created.item?.id);
    assert.equal(revived.contextAuditLog.length, 1);
    const replay = revived.createContext(
      actor,
      "ctxreq_durable",
      "decision",
      "Persist context",
      "Room memory survives relay reaping and restart."
    );
    assert.equal(replay.item?.id, created.item?.id);
    assert.equal(revived.contextList.length, 1);
  });

  test("rich agent activity is ephemeral, bounded and attributed by connection id", async () => {
    const agentSocket = new Socket();
    await room.join(mira, agentSocket, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
    room.claimWorkspace("mellery", true);
    room.setAgentActivity(
      "mellery::coder",
      "editing",
      "Editing packages/relay/src/room.ts",
      "packages/relay/src/room.ts",
      700,
      undefined,
      undefined,
      "shared"
    );
    const roster = miraSocket.sent.filter(
      (message): message is Extract<ServerMsg, { t: "roster" }> =>
        message.t === "roster" &&
        message.roster.some((member) => member.agents[0]?.activity?.phase === "editing")
    ).at(-1);
    const agent = roster?.roster.find((member) => member.handle === "mellery")?.agents[0];
    assert.equal(agent?.activity?.phase, "editing");
    assert.equal(agent?.activity?.path, "packages/relay/src/room.ts");
    assert.equal(agent?.activity?.locationScope, "shared");
    assert.equal(agent?.activity?.line, 700);
    assert.ok((agent?.activity?.updatedAt ?? 0) > 0);
    assert.equal(room.snapshot().members.some((member) => "activity" in member), false);
  });

  test("an exact activity line is hidden without a shared-workspace path", async () => {
    const agentSocket = new Socket();
    await room.join(mira, agentSocket, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
    room.setAgentActivity("mellery::coder", "editing", "Editing a private copy", "src/private.ts", 42);
    const agent = room.roster.find((member) => member.handle === "mellery")?.agents[0];
    assert.equal(agent?.activity?.path, undefined);
    assert.equal(agent?.activity?.line, undefined);
  });
});
