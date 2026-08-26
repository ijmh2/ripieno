/**
 * The bring-your-own-key path, against a real HTTP server.
 *
 * The README lists "any OpenAI-compatible endpoint" alongside Claude Code as
 * supported out of the box, and until now nothing exercised a single line of
 * it. That is the same shape as a feature that compiles and has never run —
 * and this repository already demotes one of those in its status table rather
 * than claiming it.
 *
 * So this stands up an actual server on loopback, points the runner at it, and
 * checks both halves of the contract: what we send an endpoint, and what we do
 * with what it sends back. It cannot prove any particular vendor behaves — only
 * that our side of the wire is right.
 */

const { test, describe, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const { OpenAiCompatRunner } = require("../dist/runners.js");

const servers = [];
after(() => servers.forEach((s) => s.close()));

/** An endpoint that records what it was sent and replies however the test says. */
function endpoint(reply, status = 200) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof reply === "string" ? reply : JSON.stringify(reply));
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ seen, url: `http://127.0.0.1:${server.address().port}/v1` })
    );
  });
}

const ctx = (over = {}) => ({
  system: "You are Mira's coder.",
  roster: "Room members:\n- @mellery (Mira) — present",
  unseen: "Mira (@mellery): does this build?",
  recent: "Mira (@mellery): does this build?",
  ...over,
});

const answer = (text) => ({
  choices: [{ message: { content: text } }],
  usage: { prompt_tokens: 120, completion_tokens: 34 },
});

describe("an OpenAI-compatible endpoint is driven correctly", () => {
  test("the request has the shape these APIs expect", async () => {
    const e = await endpoint(answer("It does."));
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "grok-4", apiKey: "test-key", label: "Mira's coder",
    });

    assert.equal(await runner.run(ctx(), () => {}), "It does.");

    const [req] = e.seen;
    assert.equal(req.url, "/v1/chat/completions", "the suffix is appended to the base URL");
    assert.equal(req.auth, "Bearer test-key");
    assert.equal(req.body.model, "grok-4");
    assert.equal(req.body.stream, true, "the turn streams, so the room can show it happening");
    assert.deepEqual(req.body.stream_options, { include_usage: true });
    assert.equal(req.body.tools, undefined, "no tools are offered unless the host supplies them");
    assert.equal(req.body.messages[0].role, "system");
    assert.match(req.body.messages[0].content, /Mira's coder/);
  });

  test("a trailing slash on the base URL does not double up", async () => {
    const e = await endpoint(answer("ok"));
    const runner = new OpenAiCompatRunner({
      baseUrl: `${e.url}/`, model: "m", apiKey: "k", label: "a",
    });
    await runner.run(ctx(), () => {});
    assert.equal(e.seen[0].url, "/v1/chat/completions");
  });

  test("the roster reaches the model on every turn, not just the first", async () => {
    // The window is a trailing slice, so a roster sent once scrolls out of the
    // request while the room it describes is still running.
    const e = await endpoint(answer("noted"));
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "a",
    });
    await runner.run(ctx(), () => {});
    await runner.run(ctx({ roster: "Room members:\n- @swhitfield (Sam) — present" }), () => {});

    const last = e.seen[1].body.messages.at(-1);
    assert.match(last.content, /@swhitfield \(Sam\)/, "the newcomer must be in the second turn");
  });

  test("the reply is remembered, so the next turn has the conversation", async () => {
    const e = await endpoint(answer("first answer"));
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "a",
    });
    await runner.run(ctx(), () => {});
    await runner.run(ctx(), () => {});
    assert.ok(
      e.seen[1].body.messages.some((m) => m.role === "assistant" && m.content === "first answer"),
      "a stateless API has no session, so the history has to be resent"
    );
  });

  test("tokens are reported and cost is not invented", async () => {
    const e = await endpoint(answer("hi"));
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "a",
    });
    await runner.run(ctx(), () => {});
    const usage = runner.lastUsage();
    assert.equal(usage.inputTokens, 120);
    assert.equal(usage.outputTokens, 34);
    assert.equal(usage.costUsd, undefined, "pricing is the payer's business, not ours to guess");
  });
});

describe("failures say which of the likely causes it was", () => {
  test("a remote plaintext endpoint is rejected before its Bearer key reaches fetch", async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      throw new Error("fetch should not run");
    };
    try {
      const runner = new OpenAiCompatRunner({
        baseUrl: "http://127.attacker.example/v1",
        model: "m",
        apiKey: "must-not-leak",
        label: "Mira's coder",
      });
      await assert.rejects(() => runner.run(ctx(), () => {}), /must use https:\/\//);
      assert.equal(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a rejected key surfaces the body, not just the status", async () => {
    // A bare 401 leaves a member guessing between a bad key and a bad model id.
    const e = await endpoint({ error: { message: "Incorrect API key provided" } }, 401);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "wrong", label: "Mira's coder",
    });
    await assert.rejects(() => runner.run(ctx(), () => {}), /401.*Incorrect API key/s);
  });

  test("an unreachable endpoint names the agent rather than throwing a raw fetch error", async () => {
    const runner = new OpenAiCompatRunner({
      baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "k", label: "Mira's coder",
    });
    await assert.rejects(() => runner.run(ctx(), () => {}), /Mira's coder unreachable/);
  });

  test("an empty choices array returns nothing rather than crashing", async () => {
    const e = await endpoint({ choices: [] });
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "a",
    });
    assert.equal(await runner.run(ctx(), () => {}), "");
  });
});


/**
 * An endpoint that answers with server-sent events, the way a streaming
 * chat-completions API does. `replies` is consumed one per request, so a test
 * can script a tool round followed by an answer.
 */
function sseEndpoint(replies) {
  const seen = [];
  const queue = [...replies];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(body || "{}") });
      const next = queue.shift() ?? "data: [DONE]\n\n";
      if (typeof next === "object") {
        res.writeHead(next.status ?? 400, { "content-type": "application/json" });
        res.end(JSON.stringify(next.body ?? {}));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // In pieces, so the runner's own framing is exercised rather than assumed.
      for (let at = 0; at < next.length; at += 29) res.write(next.slice(at, at + 29));
      res.end();
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ seen, url: `http://127.0.0.1:${server.address().port}/v1` })
    );
  });
}

const sse = (name) => fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8");

describe("a streamed turn", () => {
  test("content deltas become one reply, one responding phase and reported tokens", async () => {
    const e = await sseEndpoint([sse("openai-stream.sse")]);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "grok-4", apiKey: "k", label: "Mira's coder",
    });
    const events = [];
    assert.equal(await runner.run(ctx(), () => {}, (event) => events.push(event)), "It builds.");
    assert.deepEqual(
      events.filter((event) => event.type === "phase").map((event) => event.phase),
      ["thinking", "responding"]
    );
    const complete = events.at(-1);
    assert.equal(complete.type, "complete");
    assert.equal(complete.text, "It builds.");
    assert.equal(runner.lastUsage().inputTokens, 120);
    assert.equal(runner.lastUsage().outputTokens, 34);
  });

  test("an endpoint that refuses streaming is retried once without it", async () => {
    const e = await sseEndpoint([
      { status: 400, body: { error: { message: "stream is not supported by this model" } } },
      { status: 200, body: answer("Answered without streaming.") },
    ]);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "Mira's coder",
    });
    assert.equal(await runner.run(ctx(), () => {}), "Answered without streaming.");
    assert.equal(e.seen.length, 2);
    assert.equal(e.seen[0].body.stream, true);
    assert.equal(e.seen[1].body.stream, false);
    assert.equal(e.seen[1].body.stream_options, undefined);

    // And the lesson sticks: a second turn does not spend another request
    // rediscovering it.
    await runner.run(ctx(), () => {});
    assert.equal(e.seen[2].body.stream, false);
  });

  test("a refusal that is not about streaming is reported, not retried", async () => {
    const e = await sseEndpoint([
      { status: 400, body: { error: { message: "unknown model 'm'" } } },
    ]);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "Mira's coder",
    });
    await assert.rejects(() => runner.run(ctx(), () => {}), /400.*unknown model/s);
    assert.equal(e.seen.length, 1, "a bad model id is not fixed by asking again");
  });
});

describe("room tools reach a hosted model natively", () => {
  const tools = [
    {
      name: "context_add",
      description: "Propose an addition to the room's shared context.",
      parameters: { type: "object", properties: { kind: { type: "string" } } },
    },
  ];

  test("a streamed tool call is executed and its result returned to the model", async () => {
    const e = await sseEndpoint([
      sse("openai-tool-stream.sse"),
      sse("openai-stream.sse"),
    ]);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "Mira's coder",
    });
    const calls = [];
    const events = [];
    const text = await runner.run(
      ctx({
        tools,
        callTool: async (name, input) => {
          calls.push({ name, input });
          return { content: "Proposed shared context context_1.", isError: false };
        },
      }),
      () => {},
      (event) => events.push(event)
    );

    assert.equal(text, "It builds.");
    assert.deepEqual(calls, [
      { name: "context_add", input: { kind: "decision", title: "Relay owns presence" } },
    ]);
    assert.deepEqual(
      events.filter((event) => event.type === "tool").map((event) => event.safeSummary),
      ["Proposing an addition to the room's shared context"]
    );

    // The second request carries the model's own call and the result, in the
    // order these APIs require.
    const second = e.seen[1].body.messages;
    const assistant = second.find((message) => message.role === "assistant" && message.tool_calls);
    assert.equal(assistant.tool_calls[0].function.name, "context_add");
    const result = second.find((message) => message.role === "tool");
    assert.equal(result.tool_call_id, "call_1");
    assert.equal(result.content, "Proposed shared context context_1.");
    assert.deepEqual(e.seen[0].body.tools[0].function.name, "context_add");
    assert.equal(e.seen[0].body.tool_choice, "auto");
  });

  test("tool rounds are bounded, so a loop cannot run forever", async () => {
    const e = await sseEndpoint(Array.from({ length: 8 }, () => sse("openai-tool-stream.sse")));
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "Mira's coder",
    });
    let calls = 0;
    await runner.run(
      ctx({
        tools,
        callTool: async () => {
          calls += 1;
          return { content: "ok", isError: false };
        },
      }),
      () => {}
    );
    assert.equal(calls, 3, "three rounds of tools, then the turn has to answer");
    assert.equal(e.seen.length, 4);
  });

  test("no tools are offered when the host supplies no executor", async () => {
    const e = await sseEndpoint([sse("openai-stream.sse")]);
    const runner = new OpenAiCompatRunner({
      baseUrl: e.url, model: "m", apiKey: "k", label: "a",
    });
    await runner.run(ctx({ tools }), () => {});
    assert.equal(e.seen[0].body.tools, undefined);
  });
});
