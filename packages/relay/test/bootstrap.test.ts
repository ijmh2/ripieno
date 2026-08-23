/**
 * Making a relay usable by somebody who did not start it.
 *
 * Two values stood between a running process and a second person in the room:
 * a token the operator had to mint by hand, and a public address the process
 * could not see because a proxy was holding it. The second is the interesting
 * one — the fix is not a list of one host's environment variables but reading
 * what every proxy already sends, which is why most of what follows is about
 * headers rather than platforms.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  formatBootSummary,
  generateToken,
  localUrl,
  publicUrlFromEnv,
  publicUrlFromHeaders,
  resolveToken,
  toWebSocketUrl,
} from "../src/bootstrap.js";

describe("a token, one way or another", () => {
  test("an explicitly configured token is used unchanged and never written", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ripieno-boot-"));
    const resolved = await resolveToken("  supplied-secret  ", dir);
    assert.equal(resolved.token, "supplied-secret");
    assert.equal(resolved.source, "configured");
    await assert.rejects(readFile(path.join(dir, "relay-token"), "utf8"));
  });

  test("without one it generates, persists, and restores the same token next boot", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ripieno-boot-"));
    const first = await resolveToken(undefined, dir);
    assert.equal(first.source, "generated");
    assert.equal(first.persisted, true);
    assert.match(first.token, /^[0-9a-f]{48}$/);

    // The point of persisting: an invite link already sent keeps working across
    // the restart that a redeploy performs.
    const second = await resolveToken(undefined, dir);
    assert.equal(second.token, first.token);
    assert.equal(second.source, "restored");
  });

  test("with nowhere to persist it still generates, and says the link will not survive", async () => {
    const resolved = await resolveToken(undefined, undefined);
    assert.equal(resolved.source, "generated");
    assert.equal(resolved.persisted, false);
    assert.match(formatBootSummary({
      url: "wss://x", token: resolved, room: "general", requireGithub: true, observed: true,
    }), /RIPIENO_DATA_DIR/);
  });

  test("a blank saved file is not a token", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ripieno-boot-"));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "relay-token"), "   \n");
    const resolved = await resolveToken(undefined, dir);
    assert.equal(resolved.source, "generated");
    assert.notEqual(resolved.token.trim(), "");
  });

  test("generated tokens do not repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken()));
    assert.equal(seen.size, 200);
  });
});

describe("the address a proxy is holding", () => {
  test("an explicit public URL wins over every platform variable", () => {
    const url = publicUrlFromEnv({
      RIPIENO_PUBLIC_URL: "https://relay.example.com/",
      RAILWAY_PUBLIC_DOMAIN: "ignored.up.railway.app",
    } as NodeJS.ProcessEnv);
    assert.equal(url, "wss://relay.example.com");
  });

  test("platform variables are a shortcut, not the mechanism", () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ RAILWAY_PUBLIC_DOMAIN: "a.up.railway.app" }, "wss://a.up.railway.app"],
      [{ RENDER_EXTERNAL_URL: "https://b.onrender.com" }, "wss://b.onrender.com"],
      [{ KOYEB_PUBLIC_DOMAIN: "c.koyeb.app" }, "wss://c.koyeb.app"],
      [{ FLY_APP_NAME: "d" }, "wss://d.fly.dev"],
    ];
    for (const [env, expected] of cases) {
      assert.equal(publicUrlFromEnv(env as NodeJS.ProcessEnv), expected);
    }
    // Nothing configured is the ordinary case for a VPS or a tunnel, and it is
    // not an error — the header path answers it.
    assert.equal(publicUrlFromEnv({} as NodeJS.ProcessEnv), undefined);
  });

  test("a forwarded request names the address somebody was actually given", () => {
    assert.equal(
      publicUrlFromHeaders({ "x-forwarded-host": "relay.example.com", "x-forwarded-proto": "https" }),
      "wss://relay.example.com"
    );
    // A tunnel that forwards without saying so terminated TLS far more often
    // than not, so a forwarded request with no scheme is assumed secure.
    assert.equal(publicUrlFromHeaders({ "x-forwarded-host": "x.trycloudflare.com" }), "wss://x.trycloudflare.com");
    assert.equal(
      publicUrlFromHeaders({ "x-forwarded-proto": "http,https", "x-forwarded-host": "y.example" }),
      "ws://y.example"
    );
  });

  test("forwarded host beats the host the proxy itself was addressed as", () => {
    assert.equal(
      publicUrlFromHeaders({ "x-forwarded-host": "public.example", host: "internal:8080" }),
      "wss://public.example"
    );
  });

  test("an internal or loopback caller teaches nothing and is refused", () => {
    for (const host of ["localhost:8787", "127.0.0.1", "[::1]", "0.0.0.0:8787", "app.localhost"]) {
      assert.equal(publicUrlFromHeaders({ host }), undefined, host);
    }
    assert.equal(publicUrlFromHeaders({}), undefined);
    assert.equal(publicUrlFromHeaders({ host: "  " }), undefined);
  });

  test("a plain unproxied host is ws, not wss", () => {
    assert.equal(publicUrlFromHeaders({ host: "box.local:8787" }), "ws://box.local:8787");
  });

  test("whatever shape a host injects becomes a WebSocket origin", () => {
    assert.equal(toWebSocketUrl("http://a.example/"), "ws://a.example");
    assert.equal(toWebSocketUrl("wss://b.example"), "wss://b.example");
    assert.equal(toWebSocketUrl("c.example"), "wss://c.example");
  });

  test("the local fallback names something reachable, never the bind wildcard", () => {
    assert.equal(localUrl("0.0.0.0", 8787), "ws://localhost:8787");
    assert.equal(localUrl("::", 1234), "ws://localhost:1234");
    assert.equal(localUrl("127.0.0.1", 8787), "ws://127.0.0.1:8787");
  });
});

describe("what the operator is told", () => {
  const token = { token: "abc123", source: "generated" as const, persisted: true };

  test("the summary carries every value needed to reach the room", () => {
    const out = formatBootSummary({
      url: "wss://relay.example.com", token, room: "standup", requireGithub: true, observed: true,
    });
    assert.match(out, /wss:\/\/relay\.example\.com/);
    assert.match(out, /abc123/);
    assert.match(out, /standup/);
    assert.match(out, /verified against GitHub/);
    assert.doesNotMatch(out, /guessed/);
  });

  test("a guessed address says so, because sharing it would not work", () => {
    const out = formatBootSummary({
      url: "ws://localhost:8787", token, room: "general", requireGithub: false, observed: false,
    });
    assert.match(out, /guessed/);
    assert.match(out, /RIPIENO_PUBLIC_URL/);
    assert.match(out, /anyone may claim any handle/);
  });

  test("it never prints an invite link, because the URI scheme is the editor's", () => {
    const out = formatBootSummary({
      url: "wss://relay.example.com", token, room: "general", requireGithub: true, observed: true,
    });
    // Cursor, Antigravity and VS Code each register their own scheme. A relay
    // cannot know which the person joining uses, and a link that silently opens
    // the wrong editor is worse than no link.
    assert.doesNotMatch(out, /vscode:\/\//);
    assert.match(out, /Copy Invite Link/);
  });
});
