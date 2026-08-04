/**
 * Agents talking to each other, bounded.
 *
 * Agents ignored each other completely until now, and for a good reason: two
 * that answer each other's every message keep going until somebody notices the
 * bill. But "ask the reviewer to check what the coder just did" is a real
 * request, and until now the answer was that a human had to re-ask.
 *
 * The bound has two halves and this file tests the relay's. Each agent's host
 * decides whether to wake, and it needs to know how deep the chain already is —
 * so the depth is counted *here*, from the transcript, rather than being sent by
 * the client that would like it to be lower. A client names the entry it is
 * answering; it never states its own depth.
 *
 * The other half — that an agent must be *named* to be woken at all — lives in
 * the extension's addressing tests, because that is where the decision is made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentActivity, Member, RosterEntry, ServerMsg, TranscriptEntry } from "@mpa/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "ijmh2", displayName: "Mira" };
const sam: Member = { handle: "swhitfield", displayName: "Sam" };

class Socket implements SocketLike {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: ServerMsg[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as ServerMsg);
  }
  close(): void {
    this.readyState = 3;
  }
  entries(): TranscriptEntry[] {
    return this.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry);
  }
  lastRoster(): RosterEntry[] | undefined {
    return [...this.sent]
      .reverse()
      .find((m): m is Extract<ServerMsg, { t: "roster" }> => m.t === "roster")?.roster;
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

/** A room with one human watching and two agents, one per member. */
async function room(): Promise<{ room: Room; watcher: Socket }> {
  const r = new Room("r", new Driver());
  const watcher = new Socket();
  await r.join(mira, watcher);
  await r.join(mira, new Socket(), "agent", { id: "mira:coder", label: "Mira's coder" });
  await r.join(sam, new Socket(), "agent", { id: "sam:reviewer", label: "Sam's reviewer" });
  return { room: r, watcher };
}

describe("how deep a chain is, is the relay's answer and not the client's", () => {
  test("a human message starts at zero and an agent's reply to it is one", async () => {
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "does this build?");
    const question = watcher.entries().at(-1)!;
    assert.equal(question.hops ?? 0, 0);

    await r.say("ijmh2", "It does.", "agent", "mira:coder", question.id);
    assert.equal(watcher.entries().at(-1)?.hops, 1);
  });

  test("an agent answering an agent is two, and it is counted from the transcript", async () => {
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "does this build?");
    const question = watcher.entries().at(-1)!;
    await r.say("ijmh2", "It does. Sam's reviewer, check me.", "agent", "mira:coder", question.id);
    const first = watcher.entries().at(-1)!;

    await r.say("swhitfield", "Checked.", "agent", "sam:reviewer", first.id);
    assert.equal(watcher.entries().at(-1)?.hops, 2);
  });

  test("a client cannot restart the count by pointing at the wrong entry", async () => {
    // The whole reason the client sends an id rather than a number. Pointing at
    // the original human message is the most plausible way to try it, and it is
    // answered by the transcript rather than believed.
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "does this build?");
    const question = watcher.entries().at(-1)!;
    await r.say("ijmh2", "It does.", "agent", "mira:coder", question.id);
    const first = watcher.entries().at(-1)!;
    assert.equal(first.hops, 1);

    // Deep in a chain, claiming to be answering the human.
    await r.say("swhitfield", "And again.", "agent", "sam:reviewer", question.id);
    assert.equal(
      watcher.entries().at(-1)?.hops,
      1,
      "it is depth 1 because the human message is depth 0 — not because it said so"
    );
  });

  test("an unknown id is a fresh chain rather than an error", async () => {
    // A message that has aged out of the capped transcript is the honest case,
    // and refusing to post the reply would lose work that was already done.
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "nothing", "agent", "mira:coder", "an-id-from-last-week");
    assert.equal(watcher.entries().at(-1)?.hops, 1);
  });

  test("a human message is never given a depth at all", async () => {
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "hello");
    assert.equal(watcher.entries().at(-1)?.hops, undefined);
  });
});

describe("what an agent is doing reaches the room", () => {
  function stateOf(roster: RosterEntry[] | undefined, agentId: string): AgentActivity | undefined {
    return roster?.flatMap((m) => m.agents).find((a) => a.id === agentId)?.state;
  }

  test("a reported state appears in the roster against that agent", async () => {
    const { room: r, watcher } = await room();
    r.setAgentState("mira:coder", "thinking");
    assert.equal(stateOf(watcher.lastRoster(), "mira:coder"), "thinking");
    assert.equal(stateOf(watcher.lastRoster(), "sam:reviewer"), undefined, "and only that agent");
  });

  test("an agent that has never reported is absent rather than idle", async () => {
    // An agent attached over MCP has no host to report for it. Calling that
    // idle would be a claim the room cannot support.
    const { room: r, watcher } = await room();
    await r.say("ijmh2", "hello");
    assert.equal(stateOf(watcher.lastRoster(), "sam:reviewer"), undefined);
  });

  test("an unchanged state is not rebroadcast", async () => {
    // Twice a turn per agent, to every member, for no new information.
    const { room: r, watcher } = await room();
    r.setAgentState("mira:coder", "thinking");
    const before = watcher.sent.filter((m) => m.t === "roster").length;
    r.setAgentState("mira:coder", "thinking");
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before);
    r.setAgentState("mira:coder", "idle");
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before + 1);
  });

  test("a state for an agent that is not here is ignored", async () => {
    const { room: r, watcher } = await room();
    const before = watcher.sent.filter((m) => m.t === "roster").length;
    r.setAgentState("nobody:1", "thinking");
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before);
  });
});
