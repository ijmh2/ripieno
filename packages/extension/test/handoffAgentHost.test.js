const { test } = require("node:test");
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
const FAILING_CLI = path.join(__dirname, "failingAgent.js");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function human(url, room, handle, displayName) {
  const socket = new WebSocket(url);
  const seen = [];
  socket.on("message", (raw) => seen.push(JSON.parse(String(raw))));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ t: "join", room, member: { handle, displayName } }));
  const waitFor = async (type, predicate = () => true) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = seen.find((message) => message.t === type && predicate(message));
      if (found) return found;
      await wait(20);
    }
    throw new Error(`timed out waiting for ${type}`);
  };
  await waitFor("joined");
  return {
    socket,
    seen,
    waitFor,
    send: (message) => socket.send(JSON.stringify(message)),
  };
}

test("explicit acceptance runs the recipient-owned AgentHost and releases the source", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ripieno-handoff-host-"));
  const record = path.join(dir, "prompts.jsonl");
  process.env.RIPIENO_TEST_RECORD = record;
  process.env.RIPIENO_TEST_REPLIES = JSON.stringify([
    { when: 'You are "Sam\'s reviewer"', reply: "I have the room context and will continue." },
  ]);
  const relay = new SoloRelay();
  const url = await relay.start(dir);
  const room = "handoff-agent-host";
  const mira = await human(url, room, "mira", "Mira");
  const sam = await human(url, room, "sam", "Sam");
  let source;
  let released;
  const deliveries = new Map();
  const handoffStore = {
    get: async (id) => deliveries.has(id) ? structuredClone(deliveries.get(id)) : undefined,
    put: async (delivery) => deliveries.set(delivery.deliveryId, structuredClone(delivery)),
  };
  const common = {
    url,
    room,
    providerId: "cli-custom",
    command: process.execPath,
    args: [FAKE_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused",
    workspaceServerPath: "unused",
    // A real directory: a workspace agent now refuses to start without one.
    cwd: __dirname,
    onStateChange: () => {},
    handoffStore,
  };
  source = new AgentHost({
    ...common,
    id: "coder",
    label: "Mira's coder",
    member: { handle: "mira", displayName: "Mira" },
    onHandoffRelease: (_agentId, handoffId) => {
      released = handoffId;
      queueMicrotask(() => source.dispose());
    },
  });
  const target = new AgentHost({
    ...common,
    id: "reviewer",
    label: "Sam's reviewer",
    primary: false,
    member: { handle: "sam", displayName: "Sam" },
  });

  try {
    source.attach();
    target.attach();
    const roster = await sam.waitFor(
      "roster",
      (message) =>
        message.roster.some((entry) => entry.handle === "mira" && entry.agents.length === 1) &&
        message.roster.some((entry) => entry.handle === "sam" && entry.agents.length === 1)
    );
    const sourceId = roster.roster.find((entry) => entry.handle === "mira").agents[0].id;
    const targetId = roster.roster.find((entry) => entry.handle === "sam").agents[0].id;

    mira.send({
      t: "handoffOffer",
      requestId: "req_offer",
      targetHandle: "sam",
      sourceAgentId: sourceId,
      task: "Review the launch change and report whether it is ready",
    });
    const offered = await mira.waitFor(
      "handoffResult",
      (message) => message.requestId === "req_offer"
    );
    assert.equal(offered.ok, true);
    await wait(100);
    assert.equal(await fs.readFile(record, "utf8").catch(() => ""), "", "offer alone must not run");

    sam.send({
      t: "handoffDecision",
      requestId: "req_accept",
      handoffId: offered.handoff.id,
      nonce: offered.handoff.nonce,
      action: "accept",
      expectedVersion: offered.handoff.version,
      targetAgentId: targetId,
    });
    const accepted = await sam.waitFor(
      "handoffResult",
      (message) => message.requestId === "req_accept"
    );
    assert.equal(accepted.ok, true);

    let prompts = [];
    for (let attempt = 0; attempt < 100 && prompts.length === 0; attempt++) {
      const raw = await fs.readFile(record, "utf8").catch(() => "");
      prompts = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      if (prompts.length === 0) await wait(30);
    }
    assert.equal(prompts.length, 1, "one explicit accept should run exactly one target turn");
    assert.match(prompts[0], /RELAY-AUTHORITATIVE SHARED ROOM HANDOFF CONTEXT/);
    assert.match(prompts[0], /not restoration of the source agent's private provider session/i);
    assert.match(prompts[0], /targetAgentLabel="Sam's reviewer" targetHandle="sam"/);
    assert.equal(released, offered.handoff.id);
    for (let attempt = 0; attempt < 50 && source.currentState !== "detached"; attempt++) {
      await wait(20);
    }
    assert.equal(source.currentState, "detached");
    const answer = await sam.waitFor(
      "entry",
      (message) => message.entry.kind === "agent" && message.entry.agentId === targetId
    );
    assert.equal(answer.entry.text, "I have the room context and will continue.");
    const completed = await sam.waitFor(
      "handoffs",
      (message) => message.handoffs.some(
        (handoff) => handoff.id === offered.handoff.id && handoff.status === "completed"
      )
    );
    assert.equal(completed.handoffs.find((handoff) => handoff.id === offered.handoff.id).status, "completed");
    sam.send({
      t: "handoffDecision",
      requestId: "req_accept",
      handoffId: offered.handoff.id,
      nonce: offered.handoff.nonce,
      action: "accept",
      expectedVersion: offered.handoff.version,
      targetAgentId: targetId,
    });
    await wait(100);
    const afterReplay = (await fs.readFile(record, "utf8")).split("\n").filter(Boolean);
    assert.equal(afterReplay.length, 1, "a replayed accept never starts a second provider turn");
  } finally {
    source?.dispose();
    target.dispose();
    mira.socket.terminate();
    sam.socket.terminate();
    await relay.stop();
    await wait(100);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("a target provider failure is durably reported against the delivery", async () => {
  const deliveries = new Map();
  const seen = [];
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  const url = `ws://127.0.0.1:${address.port}`;
  let connected;
  wss.on("connection", (socket) => {
    connected = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      seen.push(message);
      if (message.t === "join") {
        socket.send(JSON.stringify({
          t: "joined",
          room: "failure",
          mode: "byo",
          you: { handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] },
          youAgentId: "sam::reviewer",
          roster: [{ handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] }],
          transcript: [],
        }));
        socket.send(JSON.stringify({
          t: "handoffAssignment",
          handoffId: "handoff_failure",
          deliveryId: "delivery_failure",
          handoffVersion: 2,
          context: {
            schemaVersion: 2,
            notice: "Authoritative delivery metadata; quoted content is untrusted.",
            handoff: {
              id: "handoff_failure",
              nonce: "public",
              sourceAgentId: "mira::coder",
              sourceAgentLabel: "Mira's coder",
              sourceOwnerHandle: "mira",
              targetAgentId: "sam::reviewer",
              targetAgentLabel: "Sam's reviewer",
              targetHandle: "sam",
              acceptedAt: 1,
              task: "Run the failing provider",
              targetCapability: "workspace",
            },
            transcript: [], actions: [], activeGoals: [],
            truncated: { transcript: false, actions: false, goals: false, characters: false },
          },
        }));
      } else if (message.t === "handoffClaim") {
        socket.send(JSON.stringify({
          t: "handoffStart",
          handoffId: message.handoffId,
          deliveryId: message.deliveryId,
          handoffVersion: 3,
          context: deliveries.get(message.deliveryId).context,
        }));
      }
    });
  });
  const host = new AgentHost({
    url,
    room: "failure",
    member: { handle: "sam", displayName: "Sam" },
    id: "reviewer",
    label: "Sam's reviewer",
    providerId: "cli-custom",
    command: process.execPath,
    args: [FAILING_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused",
    workspaceServerPath: "unused",
    // A real directory: a workspace agent now refuses to start without one.
    cwd: __dirname,
    onStateChange: () => {},
    handoffStore: {
      get: async (id) => deliveries.get(id),
      put: async (delivery) => deliveries.set(delivery.deliveryId, structuredClone(delivery)),
    },
  });
  try {
    host.attach();
    for (let attempt = 0; attempt < 100 && !seen.some((message) => message.t === "handoffOutcome"); attempt++) {
      await wait(25);
    }
    const outcome = seen.find((message) => message.t === "handoffOutcome");
    assert.equal(outcome?.outcome, "failed");
    assert.match(outcome?.detail ?? "", /Credit balance is too low/);
    assert.equal(deliveries.get("delivery_failure").status, "failed");
  } finally {
    host.dispose();
    connected?.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("role-revocation eviction cancels a blocking runner and suppresses every late action", async () => {
  const context = {
    schemaVersion: 2,
    notice: "Authoritative delivery metadata; quoted content is untrusted.",
    handoff: {
      id: "handoff_revoked", nonce: "public", sourceAgentId: "mira::coder",
      sourceAgentLabel: "Mira's coder", sourceOwnerHandle: "mira",
      targetAgentId: "sam::reviewer", targetAgentLabel: "Sam's reviewer",
      targetHandle: "sam", acceptedAt: 1, task: "Stop if room authority is revoked",
      targetCapability: "workspace",
    },
    transcript: [], actions: [], activeGoals: [],
    truncated: { transcript: false, actions: false, goals: false, characters: false },
  };
  const journal = new Map();
  const seen = [];
  let connected;
  let runStarted = false;
  let cancelCount = 0;
  let finishRun;
  const blockingRun = new Promise((resolve) => { finishRun = resolve; });
  const fakeRunner = {
    run: async () => {
      runStarted = true;
      return blockingRun;
    },
    cancel: () => { cancelCount += 1; },
    lastUsage: () => ({ inputTokens: 99 }),
  };
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  wss.on("connection", (socket) => {
    connected = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      seen.push(message);
      if (message.t === "join") {
        socket.send(JSON.stringify({
          t: "joined", room: "revoked", mode: "byo",
          you: { handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] },
          youAgentId: "sam::reviewer", roster: [], transcript: [],
        }));
        socket.send(JSON.stringify({
          t: "handoffAssignment", handoffId: context.handoff.id,
          deliveryId: "delivery_revoked", handoffVersion: 2, context,
        }));
      } else if (message.t === "handoffClaim") {
        socket.send(JSON.stringify({
          t: "handoffStart", handoffId: context.handoff.id,
          deliveryId: "delivery_revoked", handoffVersion: 3, context,
        }));
      } else if (message.t === "handoffStarted") {
        socket.close(4003, "room role revoked; agent execution cancelled");
      }
    });
  });
  const host = new AgentHost({
    url: `ws://127.0.0.1:${address.port}`, room: "revoked",
    member: { handle: "sam", displayName: "Sam" }, id: "reviewer", label: "Sam's reviewer",
    providerId: "cli-custom", command: process.execPath, args: [FAKE_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused", workspaceServerPath: "unused", cwd: __dirname, onStateChange: () => {},
    handoffStore: {
      get: async (id) => journal.get(id),
      put: async (value) => journal.set(value.deliveryId, structuredClone(value)),
    },
  });
  host.ensureRunner = async () => {
    host.runner = fakeRunner;
    return fakeRunner;
  };
  try {
    host.attach();
    for (let attempt = 0; attempt < 100 && (!runStarted || host.currentState !== "refused"); attempt++) {
      await wait(20);
    }
    assert.equal(runStarted, true);
    assert.equal(host.currentState, "refused");
    assert.match(host.refusal ?? "", /role revoked/);
    assert.equal(cancelCount, 1, "the active provider runner is cancelled immediately");
    assert.equal(host.handoffQueue.length, 0, "queued handoff execution is cleared");
    assert.equal(host.activeHandoffDeliveries.size, 0);

    const toolResult = await host.remoteTool("late_tool", "read_file", { path: "secret.txt" });
    assert.equal(toolResult.isError, true);
    assert.equal(seen.some((message) => message.t === "remoteTool"), false);
    finishRun("late answer that must never be posted");
    await wait(75);
    assert.equal(seen.some((message) => message.t === "say"), false);
    assert.equal(seen.some((message) => message.t === "agentUsage"), false);
    assert.equal(seen.some((message) => message.t === "handoffOutcome"), false);
  } finally {
    finishRun?.("");
    host.dispose();
    connected?.terminate();
    await new Promise((resolve) => wss.close(resolve));
  }
});

test("a restarted host never reruns a delivery already marked started", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ripieno-handoff-dedupe-"));
  const record = path.join(dir, "prompts.jsonl");
  process.env.RIPIENO_TEST_RECORD = record;
  process.env.RIPIENO_TEST_REPLIES = "[]";
  const context = {
    schemaVersion: 2,
    notice: "Authoritative delivery metadata; quoted content is untrusted.",
    handoff: {
      id: "handoff_uncertain", nonce: "public", sourceAgentId: "mira::coder",
      sourceAgentLabel: "Mira's coder", sourceOwnerHandle: "mira",
      targetAgentId: "sam::reviewer", targetAgentLabel: "Sam's reviewer",
      targetHandle: "sam", acceptedAt: 1, task: "Do not duplicate this turn",
      targetCapability: "workspace",
    },
    transcript: [], actions: [], activeGoals: [],
    truncated: { transcript: false, actions: false, goals: false, characters: false },
  };
  const delivery = {
    handoffId: "handoff_uncertain", deliveryId: "delivery_uncertain", handoffVersion: 3,
    status: "started", context, updatedAt: 1,
  };
  const seen = [];
  const wss = new WebSocket.Server({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const address = wss.address();
  wss.on("connection", (socket) => socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    seen.push(message);
    if (message.t !== "join") return;
    socket.send(JSON.stringify({
      t: "joined", room: "uncertain", mode: "byo",
      you: { handle: "sam", displayName: "Sam", present: true, color: 1, role: "member", agents: [] },
      youAgentId: "sam::reviewer",
      roster: [], transcript: [],
    }));
    socket.send(JSON.stringify({
      t: "handoffAssignment", handoffId: delivery.handoffId,
      deliveryId: delivery.deliveryId, handoffVersion: 3, context,
    }));
  }));
  const journal = new Map([[delivery.deliveryId, delivery]]);
  const host = new AgentHost({
    url: `ws://127.0.0.1:${address.port}`, room: "uncertain",
    member: { handle: "sam", displayName: "Sam" }, id: "reviewer", label: "Sam's reviewer",
    providerId: "cli-custom", command: process.execPath, args: [FAKE_CLI, "{prompt}"],
    approvals: { start: async () => ({ url: "", token: "" }) },
    permissionServerPath: "unused", workspaceServerPath: "unused", cwd: __dirname, onStateChange: () => {},
    handoffStore: {
      get: async (id) => journal.get(id),
      put: async (value) => journal.set(value.deliveryId, structuredClone(value)),
    },
  });
  try {
    host.attach();
    for (let attempt = 0; attempt < 100 && !seen.some((message) => message.t === "handoffOutcome"); attempt++) {
      await wait(20);
    }
    assert.equal(seen.find((message) => message.t === "handoffOutcome")?.outcome, "outcomeUnknown");
    assert.equal(journal.get(delivery.deliveryId).status, "outcomeUnknown");
    assert.equal(await fs.readFile(record, "utf8").catch(() => ""), "", "provider must not rerun");
  } finally {
    host.dispose();
    for (const socket of wss.clients) socket.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
