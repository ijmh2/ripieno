/**
 * What an agent is actually told, each turn.
 *
 * This is the one thing in the product that cannot be checked by reading the
 * code: the prompt is assembled from a system preamble written once per session,
 * a roster that changes underneath it, and a transcript. In a real room an agent
 * refused to answer a person — it decided from their display name that they were
 * another agent, because it had no roster to check against and every reason to
 * believe its own guess.
 *
 * So this runs the real thing: a real relay, a real AgentHost holding a real
 * room connection, and a real subprocess in place of the CLI, which writes down
 * the prompt it was handed. Nothing here asserts on an intermediate value.
 */

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const WebSocket = require("ws");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { AgentHost } = require("../dist/agentHost.js");
const { SoloRelay } = require("../dist/soloRelay.js");

const FAKE_CLI = path.join(__dirname, "rosterReachesAgent.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const cleanup = [];

after(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

/** A relay, and a file the fake CLI appends every prompt to. */
async function room(code, replies = []) {
  const relay = new SoloRelay();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpa-agent-"));
  const url = await relay.start(dir);
  const record = path.join(dir, "prompts.jsonl");
  process.env.MPA_TEST_RECORD = record;
  process.env.MPA_TEST_REPLIES = JSON.stringify(replies);
  cleanup.push(() => relay.stop());
  return {
    url,
    code,
    /** Every prompt the CLI has been given, oldest first. */
    prompts: async () => {
      const raw = await fs.readFile(record, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}

function agent(r, { id, label, handle, displayName, primary = true }) {
  const host = new AgentHost({
    id,
    label,
    primary,
    url: r.url,
    room: r.code,
    member: { handle, displayName },
    providerId: "cli-custom",
    command: process.execPath,
    args: [FAKE_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused",
    workspaceServerPath: "unused",
    onStateChange: () => {},
  });
  host.attach();
  cleanup.push(() => host.dispose());
  return host;
}

/** A person in the room, who can speak and be seen. */
async function member(r, handle, displayName) {
  const ws = new WebSocket(r.url);
  await new Promise((resolve) => ws.on("open", resolve));
  ws.send(
    JSON.stringify({ t: "join", room: r.code, member: { handle, displayName } })
  );
  await wait(250);
  cleanup.push(() => ws.terminate());
  return { say: (text) => ws.send(JSON.stringify({ t: "say", text })), ws };
}

describe("the agent is told who is in the room", () => {
  test("the roster reaches it, and stays true as the room changes", async () => {
    const r = await room("roster");
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "ijmh2",
      displayName: "Mira",
    });
    const mira = await member(r, "ijmh2", "Mira");
    await wait(300);

    mira.say("who is here?");
    await wait(3000);

    const first = (await r.prompts()).at(-1);
    assert.ok(first, "the agent should have run a turn");
    assert.match(first, /@ijmh2 \(Mira\) — present/);
    assert.match(first, /runs "Mira's coder"/);

    // Somebody joins mid-session, which is the case a roster in the system
    // preamble gets wrong: that text was written once, before they existed.
    await member(r, "swhitfield", "Sam");
    await wait(400);
    mira.say("and now?");
    await wait(3000);

    const second = (await r.prompts()).at(-1);
    assert.notEqual(second, first, "a second turn should have run");
    assert.match(second, /@swhitfield \(Sam\) — present/, "the newcomer must be in this turn");
    assert.match(second, /@ijmh2 \(Mira\)/, "and so must everyone who was already here");
  });

  test("a member's own name is never rendered as one of their agents", async () => {
    // The failure verbatim: a person whose display name reads like a label was
    // taken for an agent and refused. Whatever else the block says, the line
    // naming a person must not read as an agent's.
    const r = await room("labels");
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "ijmh2",
      displayName: "Mira",
    });
    const mira = await member(r, "ijmh2", "Mira");
    await member(r, "reviewer", "Reviewer");
    await wait(300);

    mira.say("hello");
    await wait(3000);

    const prompt = (await r.prompts()).at(-1);
    const theirLine = prompt.split("\n").find((l) => l.includes("@reviewer")) ?? "";
    assert.ok(theirLine, `nobody named @reviewer in:\n${prompt}`);
    assert.ok(!theirLine.includes("runs"), theirLine);
    assert.match(prompt, /not listed as an agent is a person/i);
  });
});

describe("an agent does not answer a message that names nobody", () => {
  test("another agent's ordinary reply does not start a conversation", async () => {
    // Two agents, one question. Exactly one turn each: the question. Neither
    // may treat the other's answer as something to respond to.
    const r = await room("chain");
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "ijmh2",
      displayName: "Mira",
    });
    agent(r, {
      id: "sam:coder",
      label: "Sam's coder",
      handle: "swhitfield",
      displayName: "Sam",
    });
    const mira = await member(r, "ijmh2", "Mira");
    await wait(400);

    mira.say("does this build?");
    // Long enough for a reply, and then for a reply to the reply to have run.
    await wait(6000);

    assert.equal(
      (await r.prompts()).length,
      2,
      "one turn per member's primary agent, and no answering each other"
    );
  });

  test("naming another agent does wake it, and the chain stops at two", async () => {
    // The behaviour worth having — one agent reports, another checks it — and
    // the bound that makes it safe to have. Sam's reviewer is not primary, so
    // every turn it runs is one it was named in.
    const r = await room("hops", [
      { when: 'You are "Mira\'s coder"', reply: "Sam's reviewer, please check this." },
      { when: 'You are "Sam\'s reviewer"', reply: "Mira's coder, one more thing." },
    ]);
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "ijmh2",
      displayName: "Mira",
    });
    agent(r, {
      id: "sam:reviewer",
      label: "Sam's reviewer",
      handle: "swhitfield",
      displayName: "Sam",
      primary: false,
    });
    const mira = await member(r, "ijmh2", "Mira");
    await wait(400);

    mira.say("does this build?");
    // Three turns' worth of debounce and process time, so a third would show.
    await wait(9000);

    const prompts = await r.prompts();
    assert.equal(prompts.length, 2, `expected the coder then the reviewer, got ${prompts.length}`);
    assert.match(prompts[0], /You are "Mira's coder"/);
    assert.match(prompts[1], /You are "Sam's reviewer"/);
    assert.match(
      prompts[1],
      /Sam's reviewer, please check this/,
      "the reviewer should have been woken by the coder naming it"
    );
    // The reviewer's own reply named the coder just as clearly. It is depth 2,
    // so nobody answers it, and a human has to speak again.
  });
});
