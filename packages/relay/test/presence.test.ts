/**
 * Ephemeral presence, and the four things that keep it honest.
 *
 * Presence is the one shared surface with no durable record behind it, so the
 * ways it can lie are all about time: too many frames, frames arriving out of
 * order, and — worst — a frame that stays on screen long after the host that
 * sent it stopped being able to make the claim. The relay, not the reporting
 * host, is what enforces all three, because a host is exactly the thing that
 * may have crashed.
 */

import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AgentActivity, AgentPresence, Member, RosterEntry, ServerMsg } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  closedWith?: number;
  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as ServerMsg);
  }
  close(code?: number): void {
    this.readyState = 3;
    this.closedWith = code;
  }
}

class Driver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("relay-enforced ephemeral presence", () => {
  const defaults = { ...Room.presenceLimits };
  let room: Room;
  let watcher: Socket;
  let agentSocket: Socket;

  const presenceOf = (id = "mellery::coder"): AgentPresence | undefined =>
    room.roster.flatMap((member) => member.agents).find((agent) => agent.id === id)?.activity;

  const rosterFrames = (): number => watcher.sent.filter((message) => message.t === "roster").length;

  const setSharedActivity = (
    id: string,
    phase: AgentActivity,
    summary: string,
    path: string,
    line?: number,
    endLine?: number,
    sequence?: number
  ): void => room.setAgentActivity(id, phase, summary, path, line, endLine, sequence, "shared");

  beforeEach(async () => {
    Object.assign(Room.presenceLimits, defaults);
    room = new Room("presence", new Driver());
    watcher = new Socket();
    agentSocket = new Socket();
    await room.join(mira, watcher);
    await room.join(mira, agentSocket, "agent", {
      id: "mellery::coder",
      label: "Mira's coder",
      capability: "workspace",
    });
    room.claimWorkspace("mellery", true);
  });

  afterEach(async () => {
    Object.assign(Room.presenceLimits, defaults);
    await room.dispose();
  });

  test("a burst of updates is coalesced to the newest, at four frames a second", async () => {
    const before = rosterFrames();
    for (let i = 1; i <= 12; i += 1) {
      setSharedActivity("mellery::coder", "reading", `Reading file ${i}`, `src/f${i}.ts`, i);
    }
    // One published immediately, the other eleven collapsed into one pending
    // frame — not eleven roster broadcasts to everybody in the room.
    assert.equal(rosterFrames(), before + 1);
    assert.equal(presenceOf()?.summary, "Reading file 1");

    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(rosterFrames(), before + 2);
    assert.equal(presenceOf()?.summary, "Reading file 12", "the newest description wins");
    assert.equal(presenceOf()?.path, "src/f12.ts");
  });

  test("a forged sequence buys no extra publication rate", async () => {
    const before = rosterFrames();
    for (let i = 0; i < 40; i += 1) {
      room.setAgentActivity(
        "mellery::coder",
        "running",
        `Running step ${i}`,
        undefined,
        undefined,
        undefined,
        1_000_000 + i
      );
    }
    // Coalescing is measured in time. Sequence only orders an agent's own
    // frames, so inflating it cannot turn 40 updates into 40 broadcasts.
    assert.equal(rosterFrames(), before + 1);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(rosterFrames(), before + 2);
  });

  test("an out-of-order or replayed frame is discarded", async () => {
    setSharedActivity("mellery::coder", "editing", "Editing a.ts", "a.ts", 3, 9, 5);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.summary, "Editing a.ts");
    assert.equal(presenceOf()?.endLine, 9);

    setSharedActivity("mellery::coder", "reading", "Stale frame", "b.ts", 1, undefined, 4);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.summary, "Editing a.ts", "an older sequence never overwrites");

    setSharedActivity("mellery::coder", "reading", "Newer frame", "b.ts", 1, undefined, 5);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.summary, "Editing a.ts", "and neither does a replay of the same one");

    setSharedActivity("mellery::coder", "reading", "Newer frame", "b.ts", 1, undefined, 6);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.summary, "Newer frame");
  });

  test("a sequence that is not a positive whole number is refused outright", () => {
    room.setAgentActivity("mellery::coder", "editing", "Bad sequence", undefined, undefined, undefined, 0);
    assert.equal(presenceOf(), undefined);
    room.setAgentActivity("mellery::coder", "editing", "Bad sequence", undefined, undefined, undefined, 1.5);
    assert.equal(presenceOf(), undefined);
    room.setAgentActivity(
      "mellery::coder",
      "editing",
      "Bad sequence",
      undefined,
      undefined,
      undefined,
      Number.MAX_SAFE_INTEGER + 10
    );
    assert.equal(presenceOf(), undefined);
  });

  test("presence expires rather than showing a stale claim forever", async () => {
    Room.presenceLimits.ttlMs = 60;
    room.setAgentActivity("mellery::coder", "editing", "Editing room.ts", "room.ts", 700, 720);
    assert.equal(presenceOf()?.phase, "editing");

    await wait(120);
    assert.equal(presenceOf(), undefined, "a read after the timeout no longer shows it");
    const agent = room.roster
      .flatMap((member) => member.agents)
      .find((entry) => entry.id === "mellery::coder");
    assert.equal(agent?.state, undefined, "and it is not reported as a coarse state either");
    assert.ok(agent, "the agent itself is still attached");

    const before = rosterFrames();
    room.sweepStalePresence();
    assert.equal(rosterFrames(), before + 1, "the expiry is delivered, not left to the next change");
    room.sweepStalePresence();
    assert.equal(rosterFrames(), before + 1, "and only once");
  });

  test("an unchanged repeat is a heartbeat: it keeps presence alive and silent", async () => {
    Room.presenceLimits.ttlMs = 200;
    room.setAgentActivity("mellery::coder", "running", "Running the test suite");
    await wait(150);
    const before = rosterFrames();
    room.setAgentActivity("mellery::coder", "running", "Running the test suite");
    assert.equal(rosterFrames(), before, "nothing new happened, so nobody is told");
    await wait(150);
    assert.equal(presenceOf()?.phase, "running", "but it has not gone stale either");
  });

  test("presence is bounded and redacted before it is shared", async () => {
    room.setAgentActivity(
      "mellery::coder",
      "running",
      `Running with api_key=supersecretvalue ${"x".repeat(400)}`,
      `${"deep/".repeat(200)}file.ts`,
      undefined,
      undefined,
      undefined,
      "shared"
    );
    await wait(Room.presenceLimits.minIntervalMs + 60);
    const presence = presenceOf();
    assert.ok((presence?.summary?.length ?? 0) <= 240);
    assert.ok((presence?.path?.length ?? 0) <= 500);
    assert.doesNotMatch(presence?.summary ?? "", /supersecretvalue/);
    assert.match(presence?.summary ?? "", /\[REDACTED\]/);
  });

  test("a range is claimed only with a shared-workspace path, and never inverted", async () => {
    room.setAgentActivity("mellery::coder", "editing", "Editing", undefined, 10, 20);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.line, undefined, "no path means no line");
    assert.equal(presenceOf()?.endLine, undefined);

    setSharedActivity("mellery::coder", "editing", "Editing", "src/a.ts", 20, 10);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.line, 20);
    assert.equal(presenceOf()?.endLine, undefined, "an end before the start is not a range");

    setSharedActivity("mellery::coder", "editing", "Editing", "src/a.ts", 20, 24);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.endLine, 24);
  });

  test("an unscoped path is withheld even while a workspace is hosted", () => {
    room.setAgentActivity("mellery::coder", "reading", "Reading a file", "src/private.ts", 4);
    assert.equal(presenceOf()?.summary, "Reading a file");
    assert.equal(presenceOf()?.path, undefined);
    assert.equal(presenceOf()?.locationScope, undefined);
  });

  test("a scoped path must still be a confined workspace-relative path", async () => {
    setSharedActivity("mellery::coder", "reading", "Reading outside", "../secret.txt", 4);
    assert.equal(presenceOf()?.path, undefined);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    room.setAgentActivity(
      "mellery::coder",
      "reading",
      "Reading an absolute file",
      "/etc/passwd",
      1,
      undefined,
      undefined,
      "private"
    );
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.path, undefined);
  });

  test("shared coordinates require a current host, while explicit private ones stay marked", async () => {
    room.claimWorkspace("mellery", false);
    setSharedActivity("mellery::coder", "editing", "Editing shared", "src/shared.ts", 5);
    assert.equal(presenceOf()?.path, undefined);

    await wait(Room.presenceLimits.minIntervalMs + 60);
    room.setAgentActivity(
      "mellery::coder",
      "editing",
      "Editing an opted-in private workspace",
      "src/private.ts",
      8,
      12,
      undefined,
      "private"
    );
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf()?.path, "src/private.ts");
    assert.equal(presenceOf()?.locationScope, "private");
    assert.equal(presenceOf()?.endLine, 12);
  });

  test("releasing the workspace clears shared coordinates but preserves coarse activity", () => {
    setSharedActivity("mellery::coder", "editing", "Editing shared", "src/shared.ts", 5, 7);
    assert.equal(presenceOf()?.path, "src/shared.ts");
    room.claimWorkspace("mellery", false);
    assert.equal(presenceOf()?.phase, "editing");
    assert.equal(presenceOf()?.summary, "Editing shared");
    assert.equal(presenceOf()?.path, undefined);
    assert.equal(presenceOf()?.locationScope, undefined);
  });

  test("detaching takes the presence and its queued frame with it", async () => {
    room.setAgentActivity("mellery::coder", "editing", "Editing a.ts", "a.ts", 4);
    room.setAgentActivity("mellery::coder", "running", "Running tests");
    await room.leave("mellery", "agent", agentSocket, "mellery::coder");
    const before = rosterFrames();
    assert.equal(presenceOf(), undefined);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(rosterFrames(), before, "the coalesced frame does not resurrect a detached agent");
    assert.equal(presenceOf(), undefined);
  });

  test("revoking a member's authority ends their agents' presence", async () => {
    await room.join(sam, new Socket());
    const samAgent = new Socket();
    await room.join(sam, samAgent, "agent", {
      id: "swhitfield::reviewer",
      label: "Sam's reviewer",
      capability: "workspace",
    });
    room.setAgentActivity("swhitfield::reviewer", "editing", "Editing a.ts", "a.ts", 4);
    await wait(Room.presenceLimits.minIntervalMs + 60);
    assert.equal(presenceOf("swhitfield::reviewer")?.phase, "editing");

    // Mira owns the room, having been the first person in it.
    await room.setRole("mellery", "swhitfield", "viewer");
    assert.equal(samAgent.closedWith, 4003);
    assert.equal(presenceOf("swhitfield::reviewer"), undefined);

    room.setAgentActivity("swhitfield::reviewer", "editing", "Still editing", "a.ts", 4);
    assert.equal(
      presenceOf("swhitfield::reviewer"),
      undefined,
      "a revoked agent cannot report anything either"
    );
  });

  test("presence is never restored from disk", async () => {
    room.setAgentActivity("mellery::coder", "editing", "Editing room.ts", "room.ts", 700, 720);
    const snapshot = room.snapshot();
    assert.equal(JSON.stringify(snapshot).includes("Editing room.ts"), false);

    const revived = new Room("presence", new Driver());
    revived.hydrate(snapshot);
    const socket = new Socket();
    await revived.join(mira, socket);
    assert.equal(
      revived.roster.flatMap((member) => member.agents).length,
      0,
      "a restarted relay knows of no live agents, and so claims no presence"
    );
    await revived.dispose();
  });

  test("presence for an agent that is not attached is ignored", () => {
    const before = rosterFrames();
    room.setAgentActivity("nobody::agent", "editing", "Editing everything", "a.ts", 1);
    assert.equal(rosterFrames(), before);
  });

  test("a phase outside the closed set is refused", () => {
    const before = rosterFrames();
    room.setAgentActivity("mellery::coder", "compiling" as never, "Compiling");
    assert.equal(rosterFrames(), before);
    assert.equal(presenceOf(), undefined);
  });
});
