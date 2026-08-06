/**
 * What each agent has cost.
 *
 * The data was already arriving and being thrown away — Claude Code returns
 * cost, tokens and turn count in the JSON the runner was parsing for the reply
 * text. The only real design question is what to do when a provider says
 * nothing, and the answer running through all of this is: nothing. A zero would
 * be the most confident number on the screen and the least true one, and the
 * agent that appears to cost nothing is exactly the one people would reach for.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Member, ServerMsg } from "@ripieno/protocol";
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
  usage(): Extract<ServerMsg, { t: "usage" }> | undefined {
    return [...this.sent].reverse().find((m): m is Extract<ServerMsg, { t: "usage" }> => m.t === "usage");
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

async function roomWithAgent(): Promise<{ room: Room; watcher: Socket }> {
  const room = new Room("r", new Driver());
  const watcher = new Socket();
  await room.join(mira, watcher);
  await room.join(mira, new Socket(), "agent", { id: "i:coder", label: "Mira's coder" });
  return { room, watcher };
}

describe("spend accumulates per agent", () => {
  test("turns and cost add up", async () => {
    const { room, watcher } = await roomWithAgent();
    room.recordUsage("i:coder", "claude-code", { costUsd: 0.5, inputTokens: 100, outputTokens: 20 });
    room.recordUsage("i:coder", "claude-code", { costUsd: 0.25, inputTokens: 50, outputTokens: 10 });

    const [entry] = room.usageReport;
    assert.equal(entry?.turns, 2);
    assert.equal(entry?.costUsd, 0.75);
    assert.equal(entry?.inputTokens, 150);
    assert.equal(entry?.outputTokens, 30);
    assert.equal(entry?.agentLabel, "Mira's coder");
    assert.equal(entry?.owner, "mellery");
    assert.equal(watcher.usage()?.agents.length, 1, "the room hears about it");
  });

  test("two agents are counted separately", async () => {
    // "Which of my agents is expensive" is the question people actually have,
    // and one number per member cannot answer it.
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    await room.join(mira, new Socket(), "agent", { id: "i:coder", label: "Mira's coder" });
    await room.join(sam, new Socket(), "agent", { id: "s:rev", label: "Sam's reviewer" });

    room.recordUsage("i:coder", "claude-code", { costUsd: 1 });
    room.recordUsage("s:rev", "claude-code", { costUsd: 2 });

    const byId = new Map(room.usageReport.map((u) => [u.agentId, u]));
    assert.equal(byId.get("i:coder")?.costUsd, 1);
    assert.equal(byId.get("s:rev")?.costUsd, 2);
    assert.equal(byId.get("s:rev")?.owner, "swhitfield");
  });

  test("an unknown agent is ignored rather than invented", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("nobody", "claude-code", { costUsd: 99 });
    assert.equal(room.usageReport.length, 0);
  });
});

describe("a provider that says nothing is not reported as free", () => {
  test("no numbers means unreported, not zero", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "codex-cli", {});
    room.recordUsage("i:coder", "codex-cli", {});

    const [entry] = room.usageReport;
    assert.equal(entry?.turns, 2, "the turns still happened");
    assert.equal(entry?.costUsd, undefined, "absent must stay absent");
    assert.equal(entry?.unreported, true);
  });

  test("tokens without a price are kept as tokens", async () => {
    // An OpenAI-compatible endpoint reports tokens and leaves pricing to whoever
    // is paying. Inventing dollars would mean shipping a price list and keeping
    // it current.
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "openai-compatible", { inputTokens: 900, outputTokens: 100 });

    const [entry] = room.usageReport;
    assert.equal(entry?.costUsd, undefined);
    assert.equal(entry?.inputTokens, 900);
    assert.equal(entry?.unreported, undefined, "it reported something");
  });

  test("one silent turn does not make a talkative provider silent", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "claude-code", { costUsd: 0.4 });
    room.recordUsage("i:coder", "claude-code", {});

    const [entry] = room.usageReport;
    assert.equal(entry?.costUsd, 0.4);
    assert.equal(entry?.unreported, undefined);
  });

  test("the provider is recorded, so nothing sums across incomparable ones", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "openai-compatible", { inputTokens: 10 });
    assert.equal(room.usageReport[0]?.provider, "openai-compatible");
  });
});

describe("spend survives a restart", () => {
  test("totals are not reset by the relay going down", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "claude-code", { costUsd: 3.5, outputTokens: 400 });

    const revived = new Room("r", new Driver());
    revived.hydrate(room.snapshot());
    assert.equal(revived.usageReport[0]?.costUsd, 3.5);
    assert.equal(revived.usageReport[0]?.turns, 1);
  });

  test("a joiner is told the room's spend immediately", async () => {
    const { room } = await roomWithAgent();
    room.recordUsage("i:coder", "claude-code", { costUsd: 1.25 });

    const joiner = new Socket();
    await room.join(sam, joiner);
    const joined = joiner.sent.find(
      (m): m is Extract<ServerMsg, { t: "joined" }> => m.t === "joined"
    );
    assert.equal(joined?.usage?.[0]?.costUsd, 1.25);
  });

  test("a snapshot written before usage existed still loads", async () => {
    const room = new Room("r", new Driver());
    room.hydrate({ transcript: [], actions: [], members: [mira] });
    assert.deepEqual(room.usageReport, []);
  });
});
