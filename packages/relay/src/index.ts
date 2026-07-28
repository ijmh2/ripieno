import { startServer, type RelayMode } from "./server.js";

// Railway (and most hosts) inject PORT. Honour it first so a deploy needs no
// bespoke config, then fall back to our own variable, then a local default.
const port = Number(process.env.PORT ?? process.env.MPA_PORT ?? 8787);
const mode: RelayMode = process.env.MPA_MODE === "hosted" ? "hosted" : "byo";
const agentId = process.env.MPA_AGENT_ID;
const environmentId = process.env.MPA_ENVIRONMENT_ID;
const token = process.env.MPA_TOKEN;
// Held only by the shared-workspace container. Without it, the workspace role
// is simply unavailable and rooms fall back to a member hosting from a laptop.
const workspaceToken = process.env.MPA_WORKSPACE_TOKEN;
// Point this at a mounted volume and room history survives redeploys too.
const dataDir = process.env.MPA_DATA_DIR;
// A deployed relay must listen on all interfaces; a local one need not.
const host = process.env.MPA_HOST ?? (process.env.PORT ? "0.0.0.0" : undefined);

// BYO is the default because it needs nothing: no API key, no agent, no
// environment, no credit balance. Members attach their own agents instead.
// Hosted mode needs both IDs from the one-time `ant beta:… create` step, and
// failing loudly here beats a confusing 404 on the first join.
if (mode === "hosted" && (!agentId || !environmentId)) {
  console.error(
    [
      "Hosted mode needs both resource IDs.",
      "",
      "  MPA_AGENT_ID        from: ant beta:agents create < infra/agent.yaml --transform id -r",
      "  MPA_ENVIRONMENT_ID  from: ant beta:environments create < infra/env.yaml --transform id -r",
      "",
      "Credentials resolve automatically from ANTHROPIC_API_KEY or an `ant auth login` profile.",
      "To run without any of that, use BYO mode (the default): unset MPA_MODE.",
    ].join("\n")
  );
  process.exit(1);
}

// Refuse to serve the public internet with no gate at all. The token is not
// authentication — a holder can still claim any handle — but without it the
// room is readable and writable by anyone who finds the URL.
if (process.env.PORT && !token) {
  console.error(
    [
      "Refusing to start: this looks like a hosted deployment (PORT is set) but MPA_TOKEN is empty.",
      "",
      "Without it, anyone who finds the URL can join any room, read the transcript and post as anyone.",
      "Set MPA_TOKEN to a long random string and give it to members alongside the relay URL.",
      "",
      "  MPA_TOKEN=$(openssl rand -hex 24)",
    ].join("\n")
  );
  process.exit(1);
}

const wss = startServer({
  port,
  mode,
  agentId,
  environmentId,
  token,
  workspaceToken,
  host,
  dataDir,
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Flush first, and await it. A redeploy sends SIGTERM, and the debounced
    // save is up to a second behind: exiting from wss.close()'s callback ran in
    // the same turn as the close listeners, so every graceful shutdown dropped
    // the tail of every busy room's history.
    void wss
      .flush()
      .catch(() => undefined)
      .then(() => wss.close(() => process.exit(0)));
  });
}
