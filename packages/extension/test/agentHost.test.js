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
  process.env.RIPIENO_TEST_RECORD = record;
  process.env.RIPIENO_TEST_REPLIES = JSON.stringify(replies);
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
      handle: "mellery",
      displayName: "Mira",
    });
    const mira = await member(r, "mellery", "Mira");
    await wait(300);

    mira.say("who is here?");
    await wait(3000);

    const first = (await r.prompts()).at(-1);
    assert.ok(first, "the agent should have run a turn");
    assert.match(first, /@mellery \(Mira\) — present/);
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
    assert.match(second, /@mellery \(Mira\)/, "and so must everyone who was already here");
  });

  test("a member's own name is never rendered as one of their agents", async () => {
    // The failure verbatim: a person whose display name reads like a label was
    // taken for an agent and refused. Whatever else the block says, the line
    // naming a person must not read as an agent's.
    const r = await room("labels");
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "mellery",
      displayName: "Mira",
    });
    const mira = await member(r, "mellery", "Mira");
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
      handle: "mellery",
      displayName: "Mira",
    });
    agent(r, {
      id: "sam:coder",
      label: "Sam's coder",
      handle: "swhitfield",
      displayName: "Sam",
    });
    const mira = await member(r, "mellery", "Mira");
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

  test("naming another agent wakes it, and the exchange terminates", async () => {
    // The behaviour worth having — one agent reports, another checks it, the
    // first responds — and the bound that makes it safe to have. Both agents
    // are scripted to keep naming each other forever, so the only thing that
    // ends this is the relay's count. Sam's reviewer is not primary, so every
    // turn it runs is one it was named in.
    const r = await room("hops", [
      { when: 'You are "Mira\'s coder"', reply: "Sam's reviewer, please check this." },
      { when: 'You are "Sam\'s reviewer"', reply: "Mira's coder, one more thing." },
    ]);
    agent(r, {
      id: "mira:coder",
      label: "Mira's coder",
      handle: "mellery",
      displayName: "Mira",
    });
    agent(r, {
      id: "sam:reviewer",
      label: "Sam's reviewer",
      handle: "swhitfield",
      displayName: "Sam",
      primary: false,
    });
    const mira = await member(r, "mellery", "Mira");
    await wait(400);

    mira.say("does this build?");
    // Long enough for several more turns, if anything were still willing.
    await wait(12_000);

    const prompts = await r.prompts();
    assert.match(prompts[0], /You are "Mira's coder"/);
    assert.match(prompts[1], /You are "Sam's reviewer"/);
    assert.match(
      prompts[1],
      /Sam's reviewer, please check this/,
      "the reviewer should have been woken by the coder naming it"
    );
    assert.equal(
      prompts.length,
      3,
      `coder, reviewer, coder — then stop. Got ${prompts.length} turns.`
    );
    // The coder's third message is its second turn since a person spoke, so it
    // carries the cap and wakes nobody. Both are still naming each other; the
    // count is the only thing ending it.
    const settled = prompts.length;
    await wait(5000);
    assert.equal((await r.prompts()).length, settled, "and it stays stopped");
  });
});

describe("what an agent may do without being asked", () => {
  // `acceptEdits` pre-approves Edit and Write for the whole session, so those
  // tools never reach --permission-prompt-tool and the approval bridge never
  // sees them. Only Bash was ever actually asked about, while the setting's own
  // description promised "asks you before anything with side effects" and the
  // README promised writes are approved by the member whose machine runs them.
  // In a shared room a write to your disk is the thing most worth being asked
  // about, so this is the one mapping in the product that must not drift.
  const { permissionMode } = require("../dist/agentHost.js");
  const vscode = require("./vscode-stub.js");
  const withSetting = (value, fn) => {
    const original = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({ get: (_k, d) => value ?? d });
    try {
      return fn();
    } finally {
      vscode.workspace.getConfiguration = original;
    }
  };

  test("the default asks, which means Claude Code's default mode and not acceptEdits", () => {
    assert.equal(withSetting(undefined, permissionMode), "default");
    assert.equal(withSetting("ask", permissionMode), "default");
  });

  test("bypass is the only way to switch prompting off", () => {
    assert.equal(withSetting("bypassPermissions", permissionMode), "bypassPermissions");
  });

  test("an unrecognised value asks rather than assuming permission", () => {
    // A setting that has been hand-edited, or written by an older build, must
    // fail towards being asked.
    assert.equal(withSetting("acceptEdits", permissionMode), "default");
    assert.equal(withSetting("", permissionMode), "default");
  });
});

describe("an agent the relay refuses says so", () => {
  // The likeliest first-run failure there is. A shared relay refuses an agent
  // connection for several ordinary reasons — a room token that is wrong or
  // missing, an identity it cannot verify, a viewer trying to attach one — and
  // closes with 4003, which RelayClient treats as terminal and never retries.
  //
  // AgentHost handled joined/entry/roster/remoteToolReply and nothing else, so
  // every `{t:"error"}` went on the floor and `onEvicted` was never passed at
  // all. The result was an agent that would never attach, presenting exactly
  // like one that was still trying.
  //
  // A real relay, a real AgentHost and a real refusal, because the two halves
  // arrive on different channels: the *reason* comes in an error frame and the
  // *finality* comes in the close code, and either half alone is still a
  // silent failure.
  const { startServer } = require("@ripieno/relay");
  const vscode = require("./vscode-stub.js");

  test("a bad room token is reported in the relay's own words", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpa-refused-"));
    const relay = startServer({
      port: 0,
      mode: "byo",
      host: "127.0.0.1",
      dataDir: dir,
      token: "the-right-token",
    });
    const port = await relay.whenListening();
    cleanup.push(
      () =>
        new Promise((resolve) => {
          for (const client of relay.clients) client.terminate();
          relay.close(() => resolve());
        })
    );

    // Distinct from every other label in this file, so the output channel this
    // asserts on cannot be an earlier agent's.
    const label = "Mira's auditor";
    const seenBefore = vscode.window.errors.length;
    // No `token`, against a relay that requires one.
    const host = agent(
      { url: `ws://127.0.0.1:${port}`, code: "refused" },
      { id: "mira:auditor", label, handle: "mellery", displayName: "Mira" }
    );

    for (let i = 0; i < 40 && host.currentState !== "refused"; i++) await wait(100);

    assert.equal(
      host.currentState,
      "refused",
      "an agent that will never attach must not still read as attaching"
    );
    // The close code's own reason is a generic "unauthorised"; this text exists
    // only in the error frame, so matching it proves that frame was read.
    assert.ok(host.refusal, "the refusal should carry a reason");
    assert.match(host.refusal, /invalid or missing room token/);

    const channel = vscode.window.channels.find((c) => c.name === `Ripieno — ${label}`);
    assert.ok(channel, "the agent should have an output channel");
    assert.ok(
      channel.lines.some((line) => /invalid or missing room token/.test(line)),
      `the reason should be in the agent's own log, got: ${channel.lines.join(" | ")}`
    );
    assert.ok(
      vscode.window.errors
        .slice(seenBefore)
        .some((m) => m.includes(label) && /invalid or missing room token/.test(m)),
      "and the person should be told which agent was refused, and why"
    );
  });
});
