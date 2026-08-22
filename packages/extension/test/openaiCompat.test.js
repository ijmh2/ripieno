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
    assert.equal(req.body.stream, false, "streaming is off — the room shows a finished answer");
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
