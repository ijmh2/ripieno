/**
 * Identity the relay checks rather than accepts.
 *
 * The room token gates who may reach the relay; it never established *who*
 * anyone is, so a holder could join as anybody. That made every attribution in
 * the product — the action log, the colour on a message, the author line in
 * `git log` — a claim rather than a fact. Roles layered on top of it would have
 * been decoration.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket = require("ws");
import type { WebSocketServer } from "ws";
import type { ServerMsg } from "@ripieno/protocol";
import { startServer } from "../src/server.js";
import { GithubVerifier } from "../src/identity.js";

const PORT = 8917;
const URL = `ws://localhost:${PORT}`;

/** GitHub, as far as these tests are concerned. */
function fakeGithub(byToken: Record<string, { login: string; name?: string } | number>): typeof fetch {
  return (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const auth = init?.headers?.Authorization ?? "";
    const answer = byToken[auth.replace("Bearer ", "")];
    if (answer === undefined) return { ok: false, status: 401, statusText: "Unauthorized" };
    if (typeof answer === "number") return { ok: false, status: answer, statusText: "Error" };
    return {
      ok: true,
      status: 200,
      json: async () => ({ login: answer.login, name: answer.name ?? null }),
    };
  }) as unknown as typeof fetch;
}

describe("the relay decides who you are", () => {
  test("the handle comes from GitHub, not from the client", async () => {
    const verifier = new GithubVerifier(fakeGithub({ "tok-mira": { login: "mellery", name: "Mira" } }));
    const result = await verifier.verify("tok-mira");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.identity.handle, "mellery");
    assert.equal(result.ok && result.identity.displayName, "Mira");
  });

  test("a login with no display name falls back to the login", async () => {
    const verifier = new GithubVerifier(fakeGithub({ t: { login: "mellery" } }));
    const result = await verifier.verify("t");
    assert.equal(result.ok && result.identity.displayName, "mellery");
  });

  test("a rejected token is refused", async () => {
    const verifier = new GithubVerifier(fakeGithub({}));
    const result = await verifier.verify("stolen");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : "", /rejected/);
  });

  test("no token at all is refused", async () => {
    const verifier = new GithubVerifier(fakeGithub({}));
    assert.equal((await verifier.verify(undefined)).ok, false);
    assert.equal((await verifier.verify("  ")).ok, false);
  });

  test("GitHub being unreachable fails closed", async () => {
    // A relay that cannot check identity must not hand out handles on trust —
    // that is exactly the state this replaces.
    const verifier = new GithubVerifier((() => {
      throw new Error("ENOTFOUND api.github.com");
    }) as unknown as typeof fetch);
    const result = await verifier.verify("tok");
    assert.equal(result.ok, false);
    assert.match(!result.ok ? result.reason : "", /could not reach GitHub/);
  });

  test("a verified token is not re-checked on every reconnect", async () => {
    // A busy room reconnects often, and GitHub's rate limit is finite.
    let calls = 0;
    const counting = ((...args: unknown[]) => {
      calls++;
      return fakeGithub({ tok: { login: "mellery" } })(...(args as Parameters<typeof fetch>));
    }) as unknown as typeof fetch;

    const verifier = new GithubVerifier(counting);
    await verifier.verify("tok");
    await verifier.verify("tok");
    await verifier.verify("tok");
    assert.equal(calls, 1);
  });
});

describe("a relay that requires identity", () => {
  let wss: WebSocketServer;

  before(async () => {
    wss = startServer({
      port: PORT,
      mode: "byo",
      requireGithub: true,
      verifier: new GithubVerifier(
        fakeGithub({ "tok-mallory": { login: "mallory", name: "Mallory" } })
      ),
    });
    await new Promise((r) => setTimeout(r, 150));
  });

  after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  async function join(payload: Record<string, unknown>): Promise<ServerMsg[]> {
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on("open", r));
    const seen: ServerMsg[] = [];
    ws.on("message", (raw: WebSocket.RawData) => seen.push(JSON.parse(String(raw)) as ServerMsg));
    ws.send(JSON.stringify({ t: "join", room: "verified", ...payload }));
    await new Promise((r) => setTimeout(r, 400));
    ws.terminate();
    return seen;
  }

  test("a join with no proof of identity is refused", async () => {
    const seen = await join({ member: { handle: "mellery", displayName: "Mira" } });
    const errors = seen.filter((m) => m.t === "error").map((m) => (m as { message: string }).message);
    assert.match(errors.join(" "), /identity refused/);
    assert.equal(seen.some((m) => m.t === "joined"), false, "the join must not succeed");
  });

  test("a bad token is refused rather than trusted", async () => {
    const seen = await join({
      member: { handle: "mellery", displayName: "Mira" },
      githubToken: "not-a-real-token",
    });
    assert.equal(seen.some((m) => m.t === "joined"), false);
  });

  test("a forged handle is replaced by whoever the token really belongs to", async () => {
    // The decisive case. Mallory holds the room token and claims to be Mira.
    // Refusing the join would be adequate; taking the handle from GitHub is
    // better, because there is then no path by which a client's claim matters.
    const seen = await join({
      member: { handle: "mellery", displayName: "Mira Ellery" },
      githubToken: "tok-mallory",
    });
    const joined = seen.find((m) => m.t === "joined") as
      | Extract<ServerMsg, { t: "joined" }>
      | undefined;
    assert.ok(joined, "a valid token should get in");
    assert.equal(joined?.you.handle, "mallory", "the relay must not believe the claim");
    assert.equal(joined?.you.displayName, "Mallory");
  });

  test("the shared workspace is exempt — it proves itself another way", async () => {
    // The container has no GitHub account. It presents the workspace token,
    // which is a stronger claim than a login: only the operator has it.
    const seen = await join({
      member: { handle: "anything", displayName: "x" },
      role: "workspace",
      workspaceToken: "not-configured",
    });
    const errors = seen.filter((m) => m.t === "error").map((m) => (m as { message: string }).message);
    assert.ok(
      !errors.join(" ").includes("identity refused"),
      "it should fail on the workspace token, not on GitHub identity"
    );
  });
});
