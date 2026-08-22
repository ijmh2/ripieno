import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { MAX_GOALS, MAX_GOAL_REQUESTS, MAX_GOAL_TEXT_CHARS } from "@ripieno/protocol";
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

describe("relay-authoritative durable goals", () => {
  let room: Room;
  let miraSocket: Socket;
  let samSocket: Socket;

  beforeEach(async () => {
    room = new Room("goals", new Driver());
    miraSocket = new Socket();
    samSocket = new Socket();
    await room.join(mira, miraSocket);
    await room.join(sam, samSocket);
  });

  test("the relay mints the id and derives ownership from the actor", () => {
    const result = room.createGoal("swhitfield", "req_create", "  Ship it  ");
    assert.equal(result.ok, true);
    assert.match(result.goal!.id, /^goal_[0-9a-f-]{36}$/);
    assert.notEqual(result.goal!.id, "req_create");
    assert.equal(result.goal!.ownerHandle, "swhitfield");
    assert.equal(result.goal!.ownerName, "Sam");
    assert.equal(result.goal!.text, "Ship it");
    assert.equal(result.goal!.version, 1);
    assert.equal(result.roomRevision, 1);
    assert.equal(miraSocket.sent.at(-1)?.t, "goals");
  });

  test("only legal transitions advance goal and room versions", () => {
    const created = room.createGoal("swhitfield", "req_create", "Ship it").goal!;
    const paused = room.transitionGoal("swhitfield", "req_pause", created.id, "pause", 1);
    assert.equal(paused.goal?.status, "paused");
    assert.equal(paused.goal?.version, 2);
    assert.equal(paused.roomRevision, 2);

    const stale = room.transitionGoal("swhitfield", "req_stale", created.id, "resume", 1);
    assert.equal(stale.ok, false);
    assert.match(stale.message ?? "", /current version 2/);
    assert.equal(stale.roomRevision, 2);

    const resumed = room.transitionGoal("swhitfield", "req_resume", created.id, "resume", 2);
    const completed = room.transitionGoal("swhitfield", "req_done", created.id, "complete", 3);
    assert.equal(resumed.goal?.status, "active");
    assert.equal(completed.goal?.status, "completed");
    assert.equal(completed.goal?.version, 4);
    assert.equal(completed.roomRevision, 4);

    const terminal = room.transitionGoal("swhitfield", "req_again", created.id, "complete", 4);
    assert.equal(terminal.ok, false);
    assert.match(terminal.message ?? "", /Cannot complete a completed goal/);
  });

  test("a member cannot mutate another member's goal, but the room owner can", () => {
    const ownersGoal = room.createGoal("mellery", "req_owner_goal", "Owner's goal").goal!;
    const member = room.transitionGoal("swhitfield", "req_member", ownersGoal.id, "pause", 1);
    assert.equal(member.ok, false);
    assert.match(member.message ?? "", /Only the goal owner or room owner/);

    const membersGoal = room.createGoal("swhitfield", "req_member_goal", "Member's goal").goal!;
    const owner = room.transitionGoal("mellery", "req_owner", membersGoal.id, "pause", 1);
    assert.equal(owner.ok, true);
    assert.equal(owner.goal?.status, "paused");
  });

  test("viewers cannot create or mutate goals", () => {
    room.setRole("mellery", "swhitfield", "viewer");
    const create = room.createGoal("swhitfield", "req_create", "Nope");
    assert.equal(create.ok, false);
    assert.match(create.message ?? "", /Viewers cannot create/);

    const goal = room.createGoal("mellery", "req_owner_create", "Owner goal").goal!;
    const mutate = room.transitionGoal("swhitfield", "req_pause", goal.id, "pause", 1);
    assert.equal(mutate.ok, false);
    assert.match(mutate.message ?? "", /Viewers cannot change/);
  });

  test("identical request retries replay, while conflicting reuse fails", () => {
    const first = room.createGoal("swhitfield", "req_once", "One goal");
    const replay = room.createGoal("swhitfield", "req_once", "One goal");
    assert.deepEqual(replay, first);
    assert.equal(room.goalList.length, 1);
    assert.equal(room.goalAuditLog.length, 1);

    const conflict = room.createGoal("swhitfield", "req_once", "Different goal");
    assert.equal(conflict.ok, false);
    assert.match(conflict.message ?? "", /already used/);
    assert.equal(room.goalList.length, 1);
  });

  test("request ids are scoped to the relay-derived actor", () => {
    const miraResult = room.createGoal("mellery", "same_request", "Mira's goal");
    const samResult = room.createGoal("swhitfield", "same_request", "Sam's goal");
    assert.equal(miraResult.ok, true);
    assert.equal(samResult.ok, true);
    assert.notEqual(miraResult.goal?.id, samResult.goal?.id);

    const conflict = room.createGoal("mellery", "same_request", "Mira changed the payload");
    assert.equal(conflict.ok, false);
    assert.match(conflict.message ?? "", /already used/);
  });

  test("a successful replay returns current authoritative state, not its historical receipt", () => {
    const created = room.createGoal("swhitfield", "req_lost_ack", "Stay current");
    room.transitionGoal("swhitfield", "req_pause_after", created.goal!.id, "pause", 1);

    const replay = room.createGoal("swhitfield", "req_lost_ack", "Stay current");
    assert.equal(replay.ok, true);
    assert.equal(replay.goal?.status, "paused");
    assert.equal(replay.goal?.version, 2);
    assert.equal(replay.roomRevision, 2);
    assert.equal(replay.goals?.[0]?.status, "paused");
    assert.equal(replay.goalAudit?.at(-1)?.action, "pause");
  });

  test("goal text, request ids and room cardinality are bounded", () => {
    assert.equal(room.createGoal("mellery", "bad request id", "Nope").ok, false);
    assert.equal(room.createGoal("mellery", "req_empty", "   ").ok, false);
    assert.equal(
      room.createGoal("mellery", "req_long", "x".repeat(MAX_GOAL_TEXT_CHARS + 1)).ok,
      false
    );
    for (let index = 0; index < MAX_GOALS; index++) {
      assert.equal(room.createGoal("mellery", `req_bound_${index}`, `Goal ${index}`).ok, true);
    }
    assert.equal(room.goalList.length, MAX_GOALS);
    assert.equal(room.createGoal("mellery", "req_overflow", "One too many").ok, false);
  });

  test("a full room reclaims only its oldest completed goal", () => {
    const oldest = room.createGoal("mellery", "req_oldest", "Old completed").goal!;
    room.transitionGoal("mellery", "req_oldest_done", oldest.id, "complete", 1);
    const newer = room.createGoal("mellery", "req_newer", "Newer completed").goal!;
    room.transitionGoal("mellery", "req_newer_done", newer.id, "complete", 1);
    for (let index = 0; index < MAX_GOALS - 2; index++) {
      room.createGoal("mellery", `req_live_${index}`, `Live ${index}`);
    }

    const replacement = room.createGoal("mellery", "req_replacement", "Replacement");
    assert.equal(replacement.ok, true);
    assert.equal(room.goalList.length, MAX_GOALS);
    assert.equal(room.goalList.some((goal) => goal.id === oldest.id), false);
    assert.equal(room.goalList.some((goal) => goal.id === newer.id), true);
    assert.equal(room.goalList.filter((goal) => goal.status !== "completed").length, MAX_GOALS - 1);
  });

  test("failure churn cannot evict a live goal's successful create receipt", () => {
    const created = room.createGoal("swhitfield", "req_protected", "Keep my receipt");
    for (let index = 0; index < MAX_GOAL_REQUESTS + 50; index++) {
      room.transitionGoal(
        "swhitfield",
        `req_failure_${index}`,
        `missing_${index}`,
        "pause",
        1
      );
    }
    const snapshot = room.snapshot();
    assert.equal(snapshot.goalRequests?.length, MAX_GOAL_REQUESTS);
    assert.ok(
      snapshot.goalRequests?.some(
        (receipt) =>
          receipt.actorHandle === "swhitfield" &&
          receipt.requestId === "req_protected" &&
          receipt.kind === "create"
      )
    );
    const replay = room.createGoal("swhitfield", "req_protected", "Keep my receipt");
    assert.equal(replay.goal?.id, created.goal?.id);
    assert.equal(room.goalList.filter((goal) => goal.text === "Keep my receipt").length, 1);
  });

  test("joined and reconnect snapshots include the authoritative goal state", async () => {
    const goal = room.createGoal("swhitfield", "req_create", "Persistent context").goal!;
    const late = new Socket();
    await room.join({ handle: "kate", displayName: "Kate" }, late);
    const joined = late.sent.find(
      (message): message is Extract<ServerMsg, { t: "joined" }> => message.t === "joined"
    );
    assert.equal(joined?.goals?.[0]?.id, goal.id);
    assert.equal(joined?.roomRevision, 1);
    assert.equal(joined?.goalAudit?.length, 1);
  });
});
