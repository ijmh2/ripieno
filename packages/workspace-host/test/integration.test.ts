/**
 * The claim the whole phase rests on: the workspace outlives its members.
 *
 * A real relay, a real container against a real git repository, and a real agent
 * connection asking for files. Everything below would pass just as happily on a
 * laptop host, which is the point — the container answers the same contract, so
 * nothing above it had to change.
 *
 * Note the wss.close() dance at the end. It has hung this suite twice before:
 * `close()` waits for clients, so clients are terminated first.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import type { ServerMsg } from "@ripieno/protocol";
import { WorkspaceHost } from "../src/host.js";

const execAsync = promisify(exec);
const PORT = 8912;
const URL = `ws://127.0.0.1:${PORT}`;
const WORKSPACE_TOKEN = "workspace-secret";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A member's agent, as the relay sees one. */
class Agent {
  private readonly ws: WebSocket;
  readonly seen: ServerMsg[] = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => this.seen.push(JSON.parse(String(raw)) as ServerMsg));
  }

  static async join(room: string, handle: string, label: string): Promise<Agent> {
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on("open", r));
    const agent = new Agent(ws);
    ws.send(
      JSON.stringify({
        t: "join",
        room,
        member: { handle, displayName: handle },
        role: "agent",
        agentId: "a1",
        agentLabel: label,
      })
    );
    await wait(150);
    return agent;
  }

  /** Ask the room's workspace for something and wait for the answer. */
  async callRoom(name: string, input: Record<string, unknown>): Promise<string> {
    const requestId = `r${Math.floor(performance.now() * 1000)}`;
    this.ws.send(JSON.stringify({ t: "remoteTool", requestId, targetHandle: "room", name, input }));
    for (let i = 0; i < 100; i++) {
      // The agent receives remoteToolReply; remoteToolResult is what the host
      // sends back the other way.
      const hit = this.seen.find(
        (m) => m.t === "remoteToolReply" && (m as { requestId: string }).requestId === requestId
      );
      if (hit) return (hit as { content: string }).content;
      await wait(50);
    }
    throw new Error(`no result for ${name}`);
  }

  close(): void {
    this.ws.terminate();
  }
}

describe("a container hosts the room's workspace", () => {
  let base: string;
  let origin: string;
  let checkout: string;
  let relay: ChildProcess;
  let host: WorkspaceHost;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "mpa-host-"));
    origin = path.join(base, "origin.git");
    checkout = path.join(base, "workspace");

    // A bare repo standing in for GitHub, so clone and commit are exercised for
    // real rather than mocked into always succeeding.
    await mkdir(origin, { recursive: true });
    await execAsync(`git init --bare -b main ${origin}`);
    const seed = path.join(base, "seed");
    await execAsync(`git clone ${origin} ${seed}`);
    await writeFile(path.join(seed, "README.md"), "# shared\n", "utf8");
    await execAsync(
      "git add -A && git -c user.email=t@t -c user.name=t commit -m seed && git push origin main",
      { cwd: seed }
    );

    // The real entry point, booted the way production boots it — so the env-var
    // gates and the workspace-token check are exercised rather than bypassed.
    relay = spawn("node", ["dist/src/index.js"], {
      cwd: path.resolve(__dirname, "..", "..", "..", "relay"),
      env: { ...process.env, RIPIENO_PORT: String(PORT), RIPIENO_WORKSPACE_TOKEN: WORKSPACE_TOKEN },
      stdio: "ignore",
    });
    await wait(900);

    host = new WorkspaceHost({
      relayUrl: URL,
      room: "shared",
      root: checkout,
      keyDir: path.join(base, "keys"),
      workspaceToken: WORKSPACE_TOKEN,
      // A local bare repo stands in for GitHub, through the same binding a
      // self-hosted forge would use.
      repo: { owner: "test", name: "shared", branch: "main", url: origin },
      policy: { allow: ["echo"], allowAll: false },
    });
    await host.start();
    await wait(600);
  });

  after(async () => {
    await host.stop();
    relay.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  });

  test("an agent reads a file it has no access to itself", async () => {
    const out = await Agent.join("shared", "mellery", "Mira's coder").then((a) =>
      a.callRoom("read_file", { path: "README.md" })
    );
    assert.match(out, /# shared/);
  });

  test("an agent writes, and the file lands in the container", async () => {
    const agent = await Agent.join("shared", "swhitfield", "Sam's coder");
    const res = await agent.callRoom("write_file", { path: "notes.md", content: "from Sam" });
    assert.match(res, /Created notes\.md/);
    assert.equal(await readFile(path.join(checkout, "notes.md"), "utf8"), "from Sam");
    agent.close();
  });

  test("the commit names the agent, not the container", async () => {
    // If this fails, provenance has collapsed into one identity the moment work
    // became shared — the exact failure the design exists to avoid.
    const agent = await Agent.join("shared", "mellery", "Mira's reviewer");
    await agent.callRoom("write_file", { path: "review.md", content: "looks fine" });
    await wait(300);
    const { stdout } = await execAsync(`git log -1 --format='%an|%ae|%cn'`, { cwd: checkout });
    const [authorName, authorEmail, committerName] = stdout.trim().split("|");
    assert.equal(authorName, "Mira's reviewer");
    assert.equal(authorEmail, "mellery+agent@users.noreply.github.com");
    assert.equal(committerName, "Shared workspace", "the committer is the machine that ran it");
    agent.close();
  });

  test("two agents from different members both write, both attributed", async () => {
    const a = await Agent.join("shared", "mellery", "Mira's coder");
    const b = await Agent.join("shared", "swhitfield", "Sam's coder");
    await a.callRoom("write_file", { path: "from-mira.txt", content: "i" });
    await b.callRoom("write_file", { path: "from-sam.txt", content: "s" });
    await wait(300);
    const { stdout } = await execAsync(`git log --format='%an' -- from-mira.txt from-sam.txt`, {
      cwd: checkout,
    });
    const authors = new Set(stdout.trim().split("\n"));
    assert.ok(authors.has("Mira's coder"), `expected Mira, got ${[...authors]}`);
    assert.ok(authors.has("Sam's coder"), `expected Sam, got ${[...authors]}`);
    a.close();
    b.close();
  });

  test("a write is broadcast so every member's cache drops that path", async () => {
    const watcher = await Agent.join("shared", "watcher", "Watcher");
    const writer = await Agent.join("shared", "mellery", "Mira's coder");
    await writer.callRoom("write_file", { path: "watched.txt", content: "changed" });
    await wait(500);
    const invalidated = watcher.seen.find((m) => m.t === "workspaceInvalidated");
    assert.ok(invalidated, "members must hear about the change");
    assert.deepEqual((invalidated as { paths: string[] }).paths, ["watched.txt"]);
    watcher.close();
    writer.close();
  });

  test("a refused connection is reported, not endured in silence", async () => {
    // RelayClient stops reconnecting for good on 4003. A container that carries
    // on after that leaves the room permanently without a workspace while its
    // /health still answers 200 — so the platform never restarts it, and nobody
    // is told. Production turns this into a non-zero exit.
    const evictions: string[] = [];
    const rejected = new WorkspaceHost({
      relayUrl: URL,
      room: "shared",
      root: checkout,
      keyDir: path.join(base, "keys2"),
      workspaceToken: "wrong-token",
      policy: { allow: [], allowAll: false },
      onEvicted: (reason) => evictions.push(reason),
    });
    await rejected.start();
    await wait(700);
    assert.equal(evictions.length, 1, `expected one eviction, got ${JSON.stringify(evictions)}`);
    await rejected.stop();
  });

  test("the confinement boundary holds in the container too", async () => {
    const agent = await Agent.join("shared", "mellery", "Mira's coder");
    const out = await agent.callRoom("read_file", { path: "../../etc/passwd" });
    assert.match(out, /outside the workspace/);
    agent.close();
  });

  test("the workspace outlives everyone in the room", async () => {
    // The claim the whole phase rests on. Before this, the shared workspace was
    // a member's laptop: everyone closing their editor took the room's codebase
    // with it, mid-turn.
    const first = await Agent.join("shared", "mellery", "Mira's coder");
    await first.callRoom("write_file", { path: "outlives.txt", content: "still here" });
    first.close();

    const second = await Agent.join("shared", "swhitfield", "Sam's coder");
    second.close();
    await wait(400);

    // Everyone who was in the room is gone. A laptop host would have released
    // the claim on the way out.
    const latecomer = await Agent.join("shared", "alex", "Alex's coder");
    assert.equal(
      await latecomer.callRoom("read_file", { path: "outlives.txt" }).then((c) => /still here/.test(c)),
      true
    );
    latecomer.close();
  });

  test("an unlisted command does not run", async () => {
    const agent = await Agent.join("shared", "mellery", "Mira's coder");
    const out = await agent.callRoom("run_command", { command: "rm -rf /" });
    assert.match(out, /declined/);
    agent.close();
  });

  test("an allowed command does run", async () => {
    const agent = await Agent.join("shared", "mellery", "Mira's coder");
    const out = await agent.callRoom("run_command", { command: "echo hello-from-container" });
    assert.match(out, /hello-from-container/);
    agent.close();
  });
});
