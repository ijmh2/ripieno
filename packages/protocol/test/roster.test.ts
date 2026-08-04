/**
 * What the room tells an agent about who is in it.
 *
 * This block is the agent's only means of knowing what kind of thing is
 * speaking to it. Without it an agent judges from display names, and judges
 * with complete confidence: in a real room one refused to answer a person on
 * the grounds that they were an agent, having read their name and guessed. So
 * the contents are asserted rather than assumed, and in the protocol package
 * because both the relay and each member's extension render from this one
 * function — two renderings would drift, and the drift would be invisible
 * until an agent addressed a tool at somebody who was not there.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { colorIndexFor, describeMembers, MAX_AGENT_HOPS } from "../src/index.js";
import type { AttachedAgent, RosterEntry } from "../src/index.js";

function entry(
  handle: string,
  displayName: string,
  present = true,
  agents: AttachedAgent[] = [],
  extra: Partial<RosterEntry> = {}
): RosterEntry {
  return {
    handle,
    displayName,
    present,
    color: colorIndexFor(handle),
    agents,
    ...extra,
  };
}

const agent = (id: string, owner: string, label: string, state?: "idle" | "thinking") => ({
  id,
  owner,
  label,
  state,
});

describe("the roster names people as people", () => {
  test("everyone is listed with their handle and whether they are here", () => {
    const text = describeMembers([
      entry("ijmh2", "Mira", true, [], { repo: "ijmh2/tgtbt" }),
      entry("swhitfield", "Sam", false),
    ]);
    assert.match(text, /@ijmh2 \(Mira, working in ijmh2\/tgtbt\) — present/);
    assert.match(text, /@swhitfield \(Sam\) — OFFLINE/);
  });

  test("a member whose name reads like a label is still listed as a member", () => {
    // The failure this whole function exists for. "Reviewer" is a person here;
    // an agent with no roster has nothing to check that against but the name.
    const text = describeMembers([
      entry("reviewer", "Reviewer", true),
      entry("ijmh2", "Mira", true, [agent("a1", "ijmh2", "Mira's coder")]),
    ]);
    assert.match(text, /@reviewer \(Reviewer\) — present/);
    assert.match(text, /not listed as an agent is a person/i);
    // And their name appears outside any "runs …" clause, so it cannot be read
    // as one of Mira's agents.
    const theirLine = text.split("\n").find((l) => l.includes("@reviewer")) ?? "";
    assert.ok(!theirLine.includes("runs"), theirLine);
  });

  test("an empty room says so rather than rendering an empty list", () => {
    assert.match(describeMembers([]), /no members/i);
  });
});

describe("agents are named, and attributed to their owner", () => {
  test("a member's agents are listed against them", () => {
    const text = describeMembers([
      entry("ijmh2", "Mira", true, [
        agent("a1", "ijmh2", "Mira's coder"),
        agent("a2", "ijmh2", "Mira's reviewer"),
      ]),
    ]);
    assert.match(text, /runs "Mira's coder" and "Mira's reviewer"/);
  });

  test("an agent mid-turn says so", () => {
    // So another agent can say "the reviewer is still working" instead of
    // answering half a question as though the other half were never asked.
    const text = describeMembers([
      entry("swhitfield", "Sam", true, [agent("a2", "swhitfield", "Sam's reviewer", "thinking")]),
    ]);
    assert.match(text, /runs "Sam's reviewer" \(thinking\)/);
  });

  test("an idle agent is not decorated, and an unreported one is not called idle", () => {
    const idle = describeMembers([
      entry("ijmh2", "Mira", true, [agent("a1", "ijmh2", "Mira's coder", "idle")]),
    ]);
    assert.match(idle, /runs "Mira's coder"$/m);

    const unknown = describeMembers([
      entry("ijmh2", "Mira", true, [agent("a1", "ijmh2", "Mira's coder")]),
    ]);
    assert.match(unknown, /runs "Mira's coder"$/m);
  });

  test("a room with no agents omits the note about them", () => {
    const text = describeMembers([entry("ijmh2", "Mira", true)]);
    assert.ok(!/agent/i.test(text), text);
  });
});

describe("the shared workspace is not described as a person", () => {
  const container = entry("workspace", "Shared workspace", true, [], { kind: "workspace" });

  test("it is left out of the member list", () => {
    // Listing it invites the agent to address it as one, and to attribute work
    // to "workspace" rather than to the agent that did it.
    const text = describeMembers([entry("ijmh2", "Mira", true), container]);
    assert.match(text, /@ijmh2/);
    assert.ok(!text.includes("@workspace"), text);
  });

  test("a room of nothing but a container has no members", () => {
    assert.match(describeMembers([container]), /no members/i);
  });
});

describe("the agent-to-agent bound is a number both sides agree on", () => {
  test("two hops", () => {
    // The relay counts chains against this and each agent's host stops on it;
    // they are the same constant precisely so they cannot disagree.
    assert.equal(MAX_AGENT_HOPS, 2);
  });
});
