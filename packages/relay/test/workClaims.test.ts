import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { WORK_CLAIM_TTL_MS, type RosterEntry, type ServerMsg, type WorkClaimCreateMsg } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

class Socket implements SocketLike {
  readonly OPEN = 1; readyState = 1; sent: ServerMsg[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
}
class Driver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]) {} async say() {} async resolveToolCall() {}
}
const mira = { handle: "mira", displayName: "Mira" };
const sam = { handle: "sam", displayName: "Sam" };
function request(requestId: string, extra: Partial<WorkClaimCreateMsg> = {}): WorkClaimCreateMsg {
  return { t: "workClaimCreate", requestId, task: "Authentication tests", paths: [], ...extra };
}

describe("human-owned work claims", () => {
  let room: Room; let samSocket: Socket;
  beforeEach(async () => { room = new Room("claims", new Driver()); await room.join(mira, new Socket()); samSocket = new Socket(); await room.join(sam, samSocket); });
  afterEach(async () => { await room.dispose(); });

  test("creates attributed, bounded intentions and replays only the same live request", () => {
    room.claimWorkspace("mira", true);
    const message = request("one", { paths: ["./src//auth.ts", "src/auth.ts"] });
    const first = room.createWorkClaim("sam", message);
    assert.equal(first.ok, true);
    assert.deepEqual(room.createWorkClaim("sam", message), first);
    assert.equal(room.createWorkClaim("sam", { ...message, task: "Something else" }).ok, false);
    const [claim] = room.workClaimState.claims;
    assert.equal(claim.ownerHandle, "sam"); assert.equal(claim.ownerName, "Sam");
    assert.equal(claim.workspaceHost, "mira"); assert.deepEqual(claim.paths, ["src/auth.ts"]);
    assert.equal(room.workClaimState.claims.length, 1);
    assert.equal("workClaims" in room.snapshot(), false);
  });

  test("cannot claim another person's agent, release their work, or claim as a viewer", async () => {
    await room.join(mira, new Socket(), "agent", { id: "mira::coder", label: "Coder", capability: "workspace" });
    assert.equal(room.createWorkClaim("sam", request("forged", { agentId: "mira::coder" })).ok, false);
    const own = room.createWorkClaim("mira", request("own"));
    assert.equal(room.releaseWorkClaim("sam", "release", own.claimId!).ok, false);
    await room.setRole("mira", "sam", "viewer");
    assert.equal(room.createWorkClaim("sam", request("viewer")).ok, false);
    assert.equal(room.createWorkClaim("absent", request("absent")).ok, false);
  });

  test("invalid paths and arbitrary fields do not establish a shared coordinate", () => {
    assert.equal(room.createWorkClaim("sam", request("unhosted", { paths: ["src/a.ts"] })).ok, false);
    room.claimWorkspace("mira", true);
    for (const [i, path] of ["../private", "/etc/passwd", "a/../b", "C:\\private", "*.ts", "a\nsecret"].entries()) {
      assert.equal(room.createWorkClaim("sam", request(`bad-${i}`, { paths: [path] })).ok, false, path);
    }
    assert.equal(room.createWorkClaim("sam", request("many", { paths: Array(9).fill("a") })).ok, false);
    assert.equal(room.createWorkClaim("sam", request("long", { task: "x".repeat(241) })).ok, false);
    assert.equal(room.createWorkClaim("sam", request("goal", { goalId: "missing" })).ok, false);
  });

  test("one person wins a goal claim; completion releases it without inferring a completed task", () => {
    const goal = room.createGoal("mira", "goal", "Authentication").goal!;
    assert.equal(room.createWorkClaim("mira", request("first", { goalId: goal.id })).ok, true);
    assert.equal(room.createWorkClaim("sam", request("second", { goalId: goal.id })).ok, false);
    room.transitionGoal("mira", "done", goal.id, "complete", 1);
    assert.equal(room.workClaimState.claims.length, 0);
  });

  test("leases expire, cannot be renewed by peers, and cannot be resurrected by replay", t => {
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    const created = room.createWorkClaim("sam", request("lease"));
    now += 30_000;
    room.renewWorkClaims("mira", [created.claimId!]);
    assert.equal(room.workClaimState.claims[0].expiresAt, now - 30_000 + WORK_CLAIM_TTL_MS);
    room.renewWorkClaims("sam", [created.claimId!]);
    assert.equal(room.workClaimState.claims[0].expiresAt, now + WORK_CLAIM_TTL_MS);
    now += WORK_CLAIM_TTL_MS + 1;
    assert.equal(room.workClaimState.claims.length, 0);
    room.renewWorkClaims("sam", [created.claimId!]);
    assert.equal(room.createWorkClaim("sam", request("lease")).ok, false);
  });

  test("last human disconnect, role revocation and host changes release relevant claims", async () => {
    const otherLaptop = new Socket(); await room.join(sam, otherLaptop);
    room.createWorkClaim("sam", request("task"));
    await room.leave("sam", "human", samSocket);
    assert.equal(room.workClaimState.claims.length, 1);
    await room.leave("sam", "human", otherLaptop);
    assert.equal(room.workClaimState.claims.length, 0);
    await room.join(sam, new Socket());
    room.claimWorkspace("mira", true);
    room.createWorkClaim("sam", request("file", { paths: ["a.ts"] }));
    room.createWorkClaim("mira", request("discussion"));
    room.claimWorkspace("mira", false);
    assert.deepEqual(room.workClaimState.claims.map(c => c.task), ["Authentication tests"]);
    room.createWorkClaim("sam", request("newtask"));
    await room.setRole("mira", "sam", "viewer");
    assert.ok(room.workClaimState.claims.every(c => c.ownerHandle !== "sam"));
  });

  test("late join sees current claims and room restart cannot restore them", async () => {
    room.createWorkClaim("mira", request("current"));
    const watcher = new Socket(); await room.join({ handle: "kate", displayName: "Kate" }, watcher);
    const joined = watcher.sent.find((m): m is Extract<ServerMsg, {t:"joined"}> => m.t === "joined")!;
    assert.equal(joined.workClaims?.length, 1); assert.ok(joined.workClaimRevision! > 0);
    const restored = new Room("claims", new Driver()); restored.hydrate(room.snapshot());
    assert.equal(restored.workClaimState.claims.length, 0); await restored.dispose();
  });

  test("per-member limits bound claims without preventing other people claiming", () => {
    for (let i = 0; i < 5; i++) assert.equal(room.createWorkClaim("sam", request(`claim-${i}`)).ok, true);
    assert.equal(room.createWorkClaim("sam", request("sixth")).ok, false);
    assert.equal(room.createWorkClaim("mira", request("other")).ok, true);
  });
});
