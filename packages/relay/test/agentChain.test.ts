/**
 * Agents talking to each other, bounded.
 *
 * Agents ignored each other completely until now, and for a good reason: two
 * that answer each other's every message keep going until somebody notices the
 * bill. But "ask the reviewer to check what the coder just did" is a real
 * request, and until now the answer was that a human had to re-ask.
 *
 * The bound has two halves and this file tests the relay's. Each agent's host
 * decides whether to wake, and it needs a depth it can trust — so the relay
 * counts, per agent, how many times that agent has spoken since a person last
 * did. Nothing in a say frame influences the number.
 *
 * The first version did let the client influence it: it named the entry it was
 * answering, and the relay derived the depth from that. Which stops a client
 * stating a low number and does nothing about a client choosing a shallow
 * parent — and the test written for it drove an agent deep in a chain, had it
 * point at the original human message, watched it come back to depth 1, and
 * asserted that as proof the attack failed.
 *
 * The other half — that an agent must be *named* to be woken at all — lives in
 * the extension's addressing tests, because that is where the decision is made.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { AgentActivity, Member, RosterEntry, ServerMsg, TranscriptEntry } from "@ripieno/protocol";
import { MAX_AGENT_HOPS } from "@ripieno/protocol";
import { Room, type SocketLike } from "../src/room.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "mellery", displayName: "Mira" };
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
  test("an agent's first contribution after a person speaks is depth 1", async () => {
    const { room: r, watcher } = await room();
    await r.say("mellery", "does this build?");
    assert.equal(watcher.entries().at(-1)?.hops, undefined, "a human message carries no depth");

    await r.say("mellery", "It does.", "agent", "mira:coder");
    assert.equal(watcher.entries().at(-1)?.hops, 1);
  });

  test("every agent answering the same person is on its first turn", async () => {
    // The case a chain-position scheme gets wrong. Five people's agents all
    // answering one question are not five links in a chain; they are five
    // first replies, and counting them as deepening would silence a wide room
    // for no reason.
    const { room: r, watcher } = await room();
    await r.say("mellery", "does this build?");
    await r.say("mellery", "Yes.", "agent", "mira:coder");
    await r.say("swhitfield", "Agreed.", "agent", "sam:reviewer");

    const [coder, reviewer] = watcher.entries().slice(-2);
    assert.equal(coder.hops, 1);
    assert.equal(reviewer.hops, 1, "a second member's agent is not deeper for going second");
  });

  test("speaking twice without a person in between is what deepens", async () => {
    const { room: r, watcher } = await room();
    await r.say("mellery", "does this build?");
    await r.say("mellery", "It does. Sam's reviewer, check me.", "agent", "mira:coder");
    await r.say("swhitfield", "Checked.", "agent", "sam:reviewer");
    await r.say("mellery", "Then I will fix it.", "agent", "mira:coder");

    assert.equal(watcher.entries().at(-1)?.hops, 2, "the coder's second turn in one exchange");
  });

  test("nothing a client sends can lower its own count", async () => {
    // The property the first version of this claimed and did not have. It had
    // the client name the entry it was answering: that stops a client stating a
    // low number, but not choosing a shallow parent — an agent deep in a chain
    // could point at the original human message and be handed depth 1 forever.
    // There is now nothing in a say frame that touches the count at all.
    const { room: r, watcher } = await room();
    await r.say("mellery", "does this build?");
    for (let i = 0; i < 4; i++) {
      await r.say("mellery", `turn ${i}`, "agent", "mira:coder");
    }
    assert.deepEqual(
      watcher.entries().slice(-4).map((e) => e.hops),
      [1, 2, 3, 4],
      "the count rises with every turn regardless of what was sent"
    );
  });

  test("a person speaking restarts every count", async () => {
    const { room: r, watcher } = await room();
    await r.say("mellery", "does this build?");
    await r.say("mellery", "Yes.", "agent", "mira:coder");
    await r.say("mellery", "And again.", "agent", "mira:coder");
    assert.equal(watcher.entries().at(-1)?.hops, 2);

    await r.say("mellery", "hang on — what about the tests?");
    await r.say("mellery", "Running them now.", "agent", "mira:coder");
    assert.equal(watcher.entries().at(-1)?.hops, 1, "a human message makes it a conversation again");
  });

  test("two agents cannot talk past a bounded number of messages", async () => {
    // The failure this exists to prevent, played out. Each keeps answering the
    // other; both reach MAX_AGENT_HOPS and from then on everything they say
    // wakes nobody, whatever it says.
    const { room: r, watcher } = await room();
    await r.say("mellery", "go");
    const said: number[] = [];
    for (let i = 0; i < 6; i++) {
      await r.say("mellery", "you check", "agent", "mira:coder");
      await r.say("swhitfield", "no you", "agent", "sam:reviewer");
    }
    for (const e of watcher.entries()) if (e.hops !== undefined) said.push(e.hops);
    assert.ok(
      said.filter((h) => h < MAX_AGENT_HOPS).length <= 2,
      `only the first turn of each agent may be under the cap, got ${said.join(",")}`
    );
  });

  test("a human message is never given a depth at all", async () => {
    const { room: r, watcher } = await room();
    await r.say("mellery", "hello");
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
    await r.say("mellery", "hello");
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
    // Coarse state is presence and takes the same rate limit: a change inside
    // the window is coalesced and published on the flush, not dropped.
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before);
    await new Promise((resolve) =>
      setTimeout(resolve, Room.presenceLimits.minIntervalMs + 50)
    );
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before + 1);
  });

  test("a state for an agent that is not here is ignored", async () => {
    const { room: r, watcher } = await room();
    const before = watcher.sent.filter((m) => m.t === "roster").length;
    r.setAgentState("nobody:1", "thinking");
    assert.equal(watcher.sent.filter((m) => m.t === "roster").length, before);
  });
});
