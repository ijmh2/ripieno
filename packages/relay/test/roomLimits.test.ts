/**
 * What the room keeps, and what it tells an agent.
 *
 * Two quiet failures. A room that never empties grew without limit, because only
 * the persisted copy was capped — so what a joiner was sent and what a restart
 * brought back had drifted apart. And the shared workspace was described to
 * agents as a *person* whenever its socket happened to be down, which is exactly
 * when an agent most needs to be told the workspace is unreachable rather than
 * that a colleague has gone offline.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACE_HANDLE } from "@mpa/protocol";
import type { Member, RosterEntry, ServerMsg } from "@mpa/protocol";
import { Room, type SocketLike } from "../src/room.js";
import { rosterPrompt } from "../src/roomCore.js";
import type { RoomDriver } from "../src/driver.js";

const mira: Member = { handle: "ijmh2", displayName: "Mira" };
const container: Member = { handle: WORKSPACE_HANDLE, displayName: "Shared workspace" };

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
  joined(): Extract<ServerMsg, { t: "joined" }> {
    return this.sent.find((m): m is Extract<ServerMsg, { t: "joined" }> => m.t === "joined")!;
  }
}

class Driver implements RoomDriver {
  async sendRoster(): Promise<void> {}
  async say(): Promise<void> {}
  async resolveToolCall(): Promise<void> {}
}

describe("the shared workspace is never mistaken for a person", () => {
  test("it stays a workspace after its socket drops", async () => {
    // `kind` used to come from live connection state while the member list
    // persisted, so a container on a reconnect backoff — or any relay restart —
    // turned it into "@workspace — OFFLINE" in the agent's system prompt.
    const room = new Room("r", new Driver());
    const workspace = new Socket();
    await room.join(container, workspace, "workspace");
    await room.join(mira, new Socket());

    assert.equal(entryFor(room.roster, WORKSPACE_HANDLE)?.kind, "workspace");

    await room.leave(WORKSPACE_HANDLE, "workspace", workspace);

    const after = entryFor(room.roster, WORKSPACE_HANDLE);
    assert.equal(after?.present, false, "it really is gone");
    assert.equal(after?.kind, "workspace", "but it is still not a person");
  });

  test("a disconnected workspace is not listed to the agent as a member", async () => {
    const room = new Room("r", new Driver());
    const workspace = new Socket();
    await room.join(container, workspace, "workspace");
    await room.join(mira, new Socket());
    await room.leave(WORKSPACE_HANDLE, "workspace", workspace);

    const prompt = rosterPrompt(room.roster);
    assert.match(prompt, /@ijmh2/);
    assert.ok(!prompt.includes(`@${WORKSPACE_HANDLE}`), `described as a member:\n${prompt}`);
  });

  test("it survives a restart as a workspace", async () => {
    const first = new Room("r", new Driver());
    const workspace = new Socket();
    await first.join(container, workspace, "workspace");
    await first.join(mira, new Socket());

    const revived = new Room("r", new Driver());
    revived.hydrate(first.snapshot());
    assert.equal(entryFor(revived.roster, WORKSPACE_HANDLE)?.kind, "workspace");
    assert.ok(!rosterPrompt(revived.roster).includes(`@${WORKSPACE_HANDLE}`));
  });
});

describe("a room that never empties does not grow without limit", () => {
  test("the transcript is capped, and a joiner is sent the cap", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 700; i++) await room.say("ijmh2", `message ${i}`);

    const joiner = new Socket();
    await room.join({ handle: "sam", displayName: "Sam" }, joiner);
    const sent = joiner.joined().transcript;

    assert.ok(sent.length <= 520, `a joiner was sent ${sent.length} entries`);
    assert.ok(
      sent.some((e) => e.text === "message 699"),
      "the newest message must be there"
    );
    assert.ok(!sent.some((e) => e.text === "message 0"), "the oldest should have aged out");
  });

  test("the action log is capped too", async () => {
    const room = new Room("r", new Driver());
    await room.join(mira, new Socket());
    for (let i = 0; i < 400; i++) {
      room.recordAction({
        agentId: "a1",
        agentLabel: "Mira's coder",
        targetHandle: "ijmh2",
        verb: "wrote",
        target: `file-${i}.ts`,
        ok: true,
      });
    }
    assert.ok(room.actionLog.length <= 200, `action log held ${room.actionLog.length}`);
    assert.equal(room.actionLog.at(-1)?.target, "file-399.ts");
  });
});

describe("a failing driver degrades the room rather than corrupting it", () => {
  test("a member who joins is still tracked when the driver throws", async () => {
    // In hosted mode this is a live API call that can 429. It used to be the
    // last statement of join(), so the throw propagated out: the caller never
    // recorded the connection, the close handler became a no-op, and the member
    // was present forever in a room that could never be reaped.
    class Failing implements RoomDriver {
      async sendRoster(): Promise<void> {
        throw new Error("429 rate limited");
      }
      async say(): Promise<void> {}
      async resolveToolCall(): Promise<void> {}
    }

    const room = new Room("r", new Failing());
    const socket = new Socket();
    await room.join(mira, socket);

    assert.equal(entryFor(room.roster, "ijmh2")?.present, true);
    assert.equal(room.isEmpty, false);

    // And the room says so, rather than looking healthy.
    const said = socket.sent
      .filter((m): m is Extract<ServerMsg, { t: "entry" }> => m.t === "entry")
      .map((m) => m.entry.text)
      .join(" ");
    assert.match(said, /could not be told who is in the room/);

    // Leaving still works, so the room can be reaped.
    await room.leave("ijmh2", "human", socket);
    assert.equal(room.isEmpty, true);
  });
});

function entryFor(roster: RosterEntry[], handle: string): RosterEntry | undefined {
  return roster.find((r) => r.handle === handle);
}
