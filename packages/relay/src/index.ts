import {
  startServer,
  resolveRelayHost,
  resolveStandaloneRequireGithub,
  validateStandaloneRelayExposure,
  type RelayMode,
} from "./server.js";

// Railway (and most hosts) inject PORT. Honour it first so a deploy needs no
// bespoke config, then fall back to our own variable, then a local default.
const port = Number(process.env.PORT ?? process.env.RIPIENO_PORT ?? 8787);
const mode: RelayMode = process.env.RIPIENO_MODE === "hosted" ? "hosted" : "byo";
const agentId = process.env.RIPIENO_AGENT_ID;
const environmentId = process.env.RIPIENO_ENVIRONMENT_ID;
const token = process.env.RIPIENO_TOKEN;
// Held only by the shared-workspace container. Without it, the workspace role
// is simply unavailable and rooms fall back to a member hosting from a laptop.
const workspaceToken = process.env.RIPIENO_WORKSPACE_TOKEN;
// Point this at a mounted volume and room history survives redeploys too.
const dataDir = process.env.RIPIENO_DATA_DIR;
// A deployed relay must listen on all interfaces; a local one need not.
const host = resolveRelayHost(process.env.RIPIENO_HOST, Boolean(process.env.PORT));

const requireGithub = resolveStandaloneRequireGithub(process.env.RIPIENO_REQUIRE_GITHUB);

// BYO is the default because it needs nothing: no API key, no agent, no
// environment, no credit balance. Members attach their own agents instead.
// Hosted mode needs both IDs from the one-time `ant beta:… create` step, and
// failing loudly here beats a confusing 404 on the first join.
// Nothing here about hosted mode's resource IDs any more. It used to print
// instructions for provisioning them — `ant beta:agents create < infra/agent.yaml`
// — which named a directory that no longer exists in this repository, for a mode
// startServer refuses a few lines later regardless. Telling someone how to
// prepare for a door that is bolted shut is worse than saying it is shut, so
// the single accurate refusal in server.ts is the only thing that speaks now.

// Refuse to serve the public internet with no gate at all. The token is not
// authentication — a holder can still claim any handle — but without it the
// room is readable and writable by anyone who finds the URL.
const exposureError = validateStandaloneRelayExposure(token);
if (exposureError) {
  console.error(
    [
      exposureError,
      "",
      "Without it, anyone who finds the URL can join any room, read the transcript and post as anyone.",
      "Set RIPIENO_TOKEN to a long random string and give it to members alongside the relay URL.",
      "",
      "  RIPIENO_TOKEN=$(openssl rand -hex 24)",
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
  requireGithub,
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
