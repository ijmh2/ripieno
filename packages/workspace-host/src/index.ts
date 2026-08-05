/**
 * Entry point for the shared-workspace container.
 *
 * Deployed as its own service, never inside the relay. It runs shell commands
 * written by agents that anyone in the room can steer, and that must not share a
 * process with the thing holding the room token.
 */

import { createServer } from "node:http";
import { WorkspaceHost } from "./host.js";
import { parseRepo } from "./git.js";

const relayUrl = process.env.RIPIENO_RELAY_URL;
const room = process.env.RIPIENO_ROOM;
const workspaceToken = process.env.RIPIENO_WORKSPACE_TOKEN;
const token = process.env.RIPIENO_TOKEN;
const root = process.env.RIPIENO_WORKSPACE_DIR ?? "/data/workspace";
const keyDir = process.env.RIPIENO_KEY_DIR ?? "/data/keys";
const repo = parseRepo(
  process.env.RIPIENO_REPO,
  process.env.RIPIENO_BRANCH ?? "main",
  process.env.RIPIENO_REPO_URL
);

const missing = [
  ["RIPIENO_RELAY_URL", relayUrl],
  ["RIPIENO_ROOM", room],
  ["RIPIENO_WORKSPACE_TOKEN", workspaceToken],
].filter(([, value]) => !value);

if (missing.length > 0) {
  console.error(
    [
      `Refusing to start: missing ${missing.map(([name]) => name).join(", ")}.`,
      "",
      "  RIPIENO_RELAY_URL        wss://your-relay.up.railway.app",
      "  RIPIENO_ROOM             the room this workspace hosts",
      "  RIPIENO_WORKSPACE_TOKEN  must match the relay's own RIPIENO_WORKSPACE_TOKEN",
      "  RIPIENO_TOKEN            the room token, if the relay requires one",
      "  RIPIENO_REPO             owner/name — omit for a scratch workspace",
      "",
      "The workspace token is deliberately separate from the room token: everyone",
      "in a room holds that one, and this connection is trusted to say what every",
      "file in the repository contains.",
    ].join("\n")
  );
  process.exit(1);
}

if (process.env.RIPIENO_ALLOW_ALL_COMMANDS === "1" && !process.env.RIPIENO_I_UNDERSTAND_THE_RISK) {
  console.error(
    [
      "Refusing to start: RIPIENO_ALLOW_ALL_COMMANDS lets anyone in the room run any",
      "command in this container, because agents act on whatever members ask them to.",
      "Set RIPIENO_I_UNDERSTAND_THE_RISK=1 as well if that is genuinely what you want.",
    ].join("\n")
  );
  process.exit(1);
}

const host = new WorkspaceHost({
  relayUrl: relayUrl!,
  room: room!,
  workspaceToken: workspaceToken!,
  token,
  root,
  keyDir,
  repo,
  policy: {
    allow: (process.env.RIPIENO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    allowAll: process.env.RIPIENO_ALLOW_ALL_COMMANDS === "1",
  },
  log: (...parts) => console.log("[workspace]", ...parts),
  onEvicted: (reason) => {
    console.error(`[workspace] the relay refused this connection: ${reason}`);
    console.error("[workspace] exiting so the platform restarts us — a live /health with no room is worse.");
    process.exit(1);
  },
});

void host.start().then(async () => {
  // Printed once at boot: without the key on the repository, nothing else works,
  // and hunting for it in a container is miserable.
  if (repo) {
    console.log(
      `[workspace] deploy key for ${repo.owner}/${repo.name} ` +
        `(add at Settings → Deploy keys, with write access):\n${await host.deployKey()}`
    );
  }
});

// Railway wants something listening. It doubles as a liveness probe.
const port = Number(process.env.PORT ?? 8080);
const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ service: "ripieno-workspace", room, repo: repo ?? null }));
    return;
  }
  res.writeHead(404).end();
});
http.listen(port, "0.0.0.0");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void host.stop().then(() => process.exit(0));
  });
}
