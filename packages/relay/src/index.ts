import {
  startServer,
  resolveRelayHost,
  resolveStandaloneRequireGithub,
  validateStandaloneRelayExposure,
  type RelayMode,
} from "./server.js";
import {
  formatBootSummary,
  localUrl,
  publicUrlFromEnv,
  resolveToken,
  type ResolvedToken,
} from "./bootstrap.js";

// Railway (and most hosts) inject PORT. Honour it first so a deploy needs no
// bespoke config, then fall back to our own variable, then a local default.
const port = Number(process.env.PORT ?? process.env.RIPIENO_PORT ?? 8787);
const mode: RelayMode = process.env.RIPIENO_MODE === "hosted" ? "hosted" : "byo";
const agentId = process.env.RIPIENO_AGENT_ID;
const environmentId = process.env.RIPIENO_ENVIRONMENT_ID;
// Held only by the shared-workspace container. Without it, the workspace role
// is simply unavailable and rooms fall back to a member hosting from a laptop.
const workspaceToken = process.env.RIPIENO_WORKSPACE_TOKEN;
// Point this at a mounted volume and room history survives redeploys too.
const dataDir = process.env.RIPIENO_DATA_DIR;
// A deployed relay must listen on all interfaces; a local one need not.
const host = resolveRelayHost(process.env.RIPIENO_HOST, Boolean(process.env.PORT));
const requireGithub = resolveStandaloneRequireGithub(process.env.RIPIENO_REQUIRE_GITHUB);
// Only a suggestion, printed so the summary is copyable as a whole. Rooms are
// created by whoever joins one, so nothing here reserves it.
const room = process.env.RIPIENO_ROOM?.trim() || "general";

/**
 * How long to wait for somebody to tell us our own public address before
 * printing the local one instead.
 *
 * A deployed relay is health-checked within a second or so of coming up, and
 * that request carries the hostname it was reached on. Waiting briefly for a
 * real answer beats printing a guess that the operator then has to correct.
 */
const ADDRESS_GRACE_MS = 2_000;

async function main(): Promise<void> {
  // Generated rather than demanded. Refusing to boot without RIPIENO_TOKEN was
  // safe and made the first thing a new operator saw an error whose fix —
  // `openssl rand -hex 24` — a machine can perform for them. A generated secret
  // is not weaker than a supplied one provided it is said out loud, which is
  // what the summary below is for.
  const token: ResolvedToken = await resolveToken(process.env.RIPIENO_TOKEN, dataDir);

  // Still checked. Nothing should be able to reach this point without a token,
  // and if a change ever makes it possible, refusing is the right answer.
  const exposureError = validateStandaloneRelayExposure(token.token);
  if (exposureError) {
    console.error(exposureError);
    process.exit(1);
  }

  let announced = false;
  function announce(url: string, guessed: boolean): void {
    if (announced) return;
    announced = true;
    console.log(
      formatBootSummary({ url, token, room, requireGithub, observed: !guessed })
    );
  }

  const fromEnv = publicUrlFromEnv(process.env);

  const wss = startServer({
    port,
    mode,
    agentId,
    environmentId,
    token: token.token,
    workspaceToken,
    requireGithub,
    host,
    dataDir,
    onPublicUrl: (url) => {
      if (announced) {
        // The grace period expired and the local address was printed, then a
        // real caller arrived. Correcting is cheap; leaving a wrong address on
        // screen as the one to share is not.
        console.log(`\n  Reached on ${url} — that is the address to share.\n`);
        return;
      }
      announce(url, false);
    },
  });

  if (fromEnv) {
    announce(fromEnv, false);
  } else {
    const timer = setTimeout(() => announce(localUrl(host, port), true), ADDRESS_GRACE_MS);
    // Never hold the process open purely to print something.
    timer.unref();
  }

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
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
