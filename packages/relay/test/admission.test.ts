import { test, describe, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import WebSocket = require("ws");
import type { ClientMsg, ServerMsg } from "@ripieno/protocol";
import { compileRoomPolicy, loadRoomPolicy, parseRoomPolicy } from "../src/admission.js";
import { GithubVerifier } from "../src/identity.js";
import { FileRoomStore } from "../src/roomStore.js";
import { startServer, type ServerConfig } from "../src/server.js";

const TOKEN = "shared-relay-token";
const policy = { rooms: { restricted: ["Mira"], second: ["sam"] } };

function github(): GithubVerifier {
  const profiles: Record<string, string> = { "mira-token": "mIRA", "sam-token": "sam", "outsider-token": "outsider" };
  return new GithubVerifier((async (_url: unknown, init?: RequestInit) => {
    const token = new Headers(init?.headers).get("Authorization")?.replace(/^Bearer /, "");
    const login = token === undefined ? undefined : profiles[token];
    return new Response(JSON.stringify(login ? { login, name: login } : {}), { status: login ? 200 : 401 });
  }) as typeof fetch);
}

class Client {
  readonly seen: ServerMsg[] = [];
  readonly closed: Promise<number>;

  constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.seen.push(JSON.parse(String(raw)) as ServerMsg));
    this.closed = new Promise((resolve) => socket.once("close", resolve));
  }

  send(msg: ClientMsg): void { this.socket.send(JSON.stringify(msg)); }

  async waitFor(predicate: (msg: ServerMsg) => boolean): Promise<ServerMsg> {
    const existing = this.seen.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const onMessage = (): void => {
        const match = this.seen.find(predicate);
        if (match) { cleanup(); resolve(match); }
      };
      const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for relay frame")); }, 3000);
      const cleanup = (): void => { clearTimeout(timer); this.socket.off("message", onMessage); };
      this.socket.on("message", onMessage);
    });
  }
}

async function relay(t: TestContext, overrides: Partial<ServerConfig> = {}) {
  const server = startServer({ port: 0, mode: "byo", token: TOKEN, requireGithub: true, roomPolicy: policy, verifier: github(), ...overrides });
  const port = await server.whenListening();
  t.after(async () => {
    await server.flush();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return async (payload: Partial<Extract<ClientMsg, { t: "join" }>> = {}) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const client = new Client(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    client.send({ t: "join", room: "restricted", token: TOKEN, member: { handle: "Mira", displayName: "Claimed owner" }, githubToken: "mira-token", ...payload });
    return client;
  };
}

async function denied(client: Client, message = /room access denied/): Promise<void> {
  await client.waitFor((msg) => msg.t === "error");
  assert.equal(await client.closed, 4003);
  assert.equal(client.seen.length, 1, "a refused client receives only its error, never room data");
  const error = client.seen[0];
  assert.ok(error?.t === "error");
  assert.match(error.message, message);
}

describe("room admission policy configuration", () => {
  test("rejects malformed policy instead of becoming a trusted-team relay", () => {
    for (const value of [null, [], {}, { room: {} }, { rooms: {}, extra: true }, { rooms: [] }, { rooms: { "": ["mira"] } }, { rooms: { " padded": ["mira"] } }, { rooms: { r: [] } }, { rooms: { r: "mira" } }, { rooms: { r: ["@mira"] } }, { rooms: { r: ["mira", "MIRA"] } }, { rooms: { r: ["not a login"] } }]) {
      assert.throws(() => parseRoomPolicy(value), /Invalid room admission policy/);
    }
  });

  test("uses exact room names and case-insensitive logins, with a copied policy", () => {
    const config = { rooms: { Project: ["Mira"] } };
    const allows = compileRoomPolicy(config);
    config.rooms.Project.push("outsider");
    assert.equal(allows("Project", "mIRA"), true);
    assert.equal(allows("project", "mira"), false);
    assert.equal(allows("Project", "outsider"), false);
    assert.equal(compileRoomPolicy({ rooms: {} })("anything", "mira"), false);
  });

  test("rejects room policies whose different codes share a persisted filename", () => {
    assert.throws(() => parseRoomPolicy({ rooms: { Project: ["mira"], project: ["sam"] } }), /history filename/);
    const code = "a/b";
    const alias = `a_b-${createHash("sha256").update(code).digest("hex").slice(0, 12)}`;
    assert.throws(() => parseRoomPolicy({ rooms: { [code]: ["mira"], [alias]: ["sam"] } }), /history filename/);
  });

  test("requires explicit identity verification before listening", () => {
    for (const requireGithub of [false, undefined]) {
      assert.throws(() => startServer({ port: 0, mode: "byo", roomPolicy: policy, requireGithub }), /requires RIPIENO_REQUIRE_GITHUB/);
    }
    assert.throws(() => startServer({ port: 0, mode: "byo", roomPolicy: { rooms: { r: [] } }, requireGithub: true }), /Invalid room admission policy/);
  });

  test("a configured file must be readable valid JSON, including Windows UTF-8 BOM support", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ripieno-admission-config-"));
    try {
      const file = path.join(dir, "policy.json");
      assert.equal(await loadRoomPolicy(undefined), undefined);
      await assert.rejects(loadRoomPolicy(""), /must name a file/);
      await assert.rejects(loadRoomPolicy(file), /could not read/);
      await writeFile(file, "not-json");
      await assert.rejects(loadRoomPolicy(file), /valid JSON/);
      await writeFile(file, "{}");
      await assert.rejects(loadRoomPolicy(file), /rooms/);
      await writeFile(file, `\uFEFF${JSON.stringify(policy)}`);
      assert.deepEqual(await loadRoomPolicy(file), { rooms: { restricted: ["mira"], second: ["sam"] } });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("room admission on real loopback WebSockets", () => {
  test("only an allowed verified account can receive a live room's transcript, including agents", async (t) => {
    const connect = await relay(t);
    const owner = await connect({ member: { handle: "unrelated", displayName: "Forged name" } });
    const joined = await owner.waitFor((msg) => msg.t === "joined");
    assert.ok(joined.t === "joined");
    assert.equal(joined.you.handle, "mIRA");
    assert.equal(joined.you.role, "owner");
    owner.send({ t: "say", text: "private room transcript" });
    await owner.waitFor((msg) => msg.t === "entry" && msg.entry.text === "private room transcript");

    // Both outsiders know the relay token and claim the allowed owner's handle.
    for (const role of ["human", "agent"] as const) {
      await denied(await connect({ role, githubToken: "outsider-token" }));
    }
    // Admission is per-room: Sam is allowed in second, never in restricted.
    await denied(await connect({ githubToken: "sam-token" }));
    const agent = await connect({ role: "agent" });
    const agentJoined = await agent.waitFor((msg) => msg.t === "joined");
    assert.ok(agentJoined.t === "joined");
    assert.ok(agentJoined.transcript.some((entry) => entry.text === "private room transcript"));
    assert.equal(agentJoined.youAgentId, "mIRA::default");
  });

  test("unknown or differently cased rooms deny even an allowed account", async (t) => {
    const connect = await relay(t);
    await denied(await connect({ room: "unknown" }));
    await denied(await connect({ room: "Restricted" }));
    const sam = await connect({ room: "second", githubToken: "sam-token" });
    assert.equal((await sam.waitFor((msg) => msg.t === "joined")).t, "joined");
  });

  test("the relay token and GitHub proof remain mandatory", async (t) => {
    const connect = await relay(t);
    await denied(await connect({ token: "wrong" }), /invalid or missing room token/);
    await denied(await connect({ githubToken: undefined }), /identity refused/);
    await denied(await connect({ githubToken: "forged-proof" }), /identity refused/);
  });

  test("a global workspace token cannot bypass restricted-room admission", async (t) => {
    const connect = await relay(t, { workspaceToken: "global-workspace-secret" });
    await denied(await connect({ role: "workspace", workspaceToken: "global-workspace-secret" }), /workspace connections are unavailable/);
  });

  test("denied joins cannot restore or change persisted rooms, or create unknown rooms", async (t) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ripieno-admission-history-"));
    // This relay admits nobody in the test, so there are no asynchronous room
    // saves at shutdown. Cleanup is registered before the server's close hook.
    t.after(async () => { await rm(dir, { recursive: true, force: true }); });
    const store = new FileRoomStore(dir);
    await store.save("restricted", {
      members: [{ handle: "mIRA", displayName: "Mira" }],
      roles: { mIRA: "owner" }, actions: [],
      transcript: [{ id: "secret", kind: "system", text: "persisted private transcript", authorHandle: "mIRA", authorName: "Mira", ts: Date.now() }],
    });
    const filesBefore = await readdir(dir);
    const contentsBefore = await Promise.all(filesBefore.map((file) => readFile(path.join(dir, file), "utf8")));
    const connect = await relay(t, { dataDir: dir });
    for (const role of ["human", "agent"] as const) {
      await denied(await connect({ role, githubToken: "outsider-token" }));
      await denied(await connect({ role, room: "unknown" }));
    }
    assert.deepEqual(await readdir(dir), filesBefore);
    assert.deepEqual(await Promise.all(filesBefore.map((file) => readFile(path.join(dir, file), "utf8"))), contentsBefore);
  });

  test("omitting the policy preserves trusted-team admission", async (t) => {
    const connect = await relay(t, { roomPolicy: undefined });
    const outsider = await connect({ room: "new-room", githubToken: "outsider-token" });
    const joined = await outsider.waitFor((msg) => msg.t === "joined");
    assert.ok(joined.t === "joined");
    assert.equal(joined.you.handle, "outsider");
  });
});
