/**
 * The two things a relay needs before anyone but its operator can use it: a
 * token, and knowledge of its own public address.
 *
 * Standing one up used to end with a running process and no way to tell anybody
 * how to reach it. The operator ran `openssl` for a token, read the public
 * hostname off a dashboard, and hand-assembled three values from three places —
 * and the token is the one nobody retypes correctly.
 *
 * Neither problem is Railway's in particular, which is why nothing here is.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Long enough that guessing is hopeless, short enough to paste in one go. */
const TOKEN_BYTES = 24;
const TOKEN_FILE = "relay-token";

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export interface ResolvedToken {
  token: string;
  /** How it was obtained, so the boot summary can say something true about it. */
  source: "configured" | "restored" | "generated";
  /** False when there is no data dir, meaning a restart invalidates every link. */
  persisted: boolean;
}

/**
 * A token, one way or another.
 *
 * Refusing to boot without one was the safe default and the wrong one: it made
 * the first thing a new operator met an error message, and the fix it suggested
 * — `openssl rand -hex 24` — is a step a machine can do for them. Generating is
 * not weaker than being told, so long as the result is said out loud, which is
 * what the boot summary is for.
 *
 * Persisted when there is somewhere to put it, because a token that rotates on
 * every restart silently breaks every invite link already sent.
 */
export async function resolveToken(
  configured: string | undefined,
  dataDir: string | undefined
): Promise<ResolvedToken> {
  const explicit = configured?.trim();
  if (explicit) return { token: explicit, source: "configured", persisted: true };

  if (dataDir) {
    const file = path.join(dataDir, TOKEN_FILE);
    try {
      const saved = (await readFile(file, "utf8")).trim();
      if (saved) return { token: saved, source: "restored", persisted: true };
    } catch {
      // No token yet, which is the ordinary first-boot case.
    }
    const token = generateToken();
    try {
      await mkdir(dataDir, { recursive: true });
      // 0o600: the volume may be shared with the workspace container.
      await writeFile(file, `${token}\n`, { mode: 0o600 });
      return { token, source: "generated", persisted: true };
    } catch {
      return { token, source: "generated", persisted: false };
    }
  }

  return { token: generateToken(), source: "generated", persisted: false };
}

/**
 * Where this relay looks like it lives, from the outside.
 *
 * Deliberately not a list of one host's environment variables. A relay behind a
 * proxy cannot see its own public name, but the proxy tells it on every single
 * request — so the general answer is to read that, and the platform variables
 * below are only a shortcut that saves waiting for the first one.
 *
 * Never use this for a security decision. `Host` and `X-Forwarded-Host` are
 * attacker-controlled, and this value exists to be printed to an operator, not
 * to authorise anything.
 */
export function publicUrlFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env.RIPIENO_PUBLIC_URL?.trim();
  if (explicit) return toWebSocketUrl(explicit);

  // Each is the variable that host injects for its own public hostname. They
  // are a convenience: without any of them the header path below still works.
  const candidates = [
    env.RAILWAY_PUBLIC_DOMAIN,
    env.RENDER_EXTERNAL_URL,
    env.RENDER_EXTERNAL_HOSTNAME,
    env.KOYEB_PUBLIC_DOMAIN,
    env.FLY_APP_NAME ? `${env.FLY_APP_NAME}.fly.dev` : undefined,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return toWebSocketUrl(value);
  }
  return undefined;
}

/**
 * The public origin implied by one request's headers.
 *
 * Returns undefined for anything that cannot be an outside address — a platform
 * healthcheck usually arrives on an internal name, and printing that as the
 * address to share would be worse than printing nothing.
 */
export function publicUrlFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  fallbackSecure = false
): string | undefined {
  const forwardedHost = firstHeader(headers["x-forwarded-host"]);
  const host = forwardedHost ?? firstHeader(headers.host);
  if (!host || !isExternalHost(host)) return undefined;

  const proto = firstHeader(headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  // A forwarded request that says nothing about scheme reached a proxy that
  // terminated TLS far more often than it did not.
  const secure = proto ? proto === "https" || proto === "wss" : forwardedHost ? true : fallbackSecure;
  return `${secure ? "wss" : "ws"}://${host.replace(/\/+$/, "")}`;
}

/** Loopback and bare addresses are how a relay is reached from its own machine. */
function isExternalHost(rawHost: string): boolean {
  const host = rawHost.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (name === "localhost" || name.endsWith(".localhost")) return false;
  if (name === "::1" || name.startsWith("127.")) return false;
  if (name === "0.0.0.0" || name === "::") return false;
  // A private address is reachable by a colleague on the same network, so it is
  // genuinely shareable — but it needs a name, not an empty string.
  return name.length > 0;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

/** Accepts whatever shape a host injects and returns a WebSocket origin. */
export function toWebSocketUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("wss://") || trimmed.startsWith("ws://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  // A bare hostname from a platform variable is always public, therefore TLS.
  return `wss://${trimmed}`;
}

/** What a local relay is reachable on, when nothing has told us otherwise. */
export function localUrl(host: string, port: number): string {
  const shown = host === "0.0.0.0" || host === "::" || host === "" ? "localhost" : host;
  return `ws://${shown}:${port}`;
}

export interface BootSummary {
  url: string;
  token: ResolvedToken;
  room: string;
  requireGithub: boolean;
  /** True once the address came from a real request rather than a guess. */
  observed: boolean;
}

/**
 * The whole of what an operator has to know, in one block they can copy.
 *
 * Prints values rather than a ready-made invite link on purpose. The link's URI
 * scheme belongs to the *editor* — Cursor, Antigravity and VS Code each register
 * their own — and the relay cannot know which one the person joining uses. The
 * editor's own Copy Invite Link builds it correctly; this only has to get
 * somebody to the point of being able to press it.
 */
export function formatBootSummary(summary: BootSummary): string {
  const { url, token, room, requireGithub, observed } = summary;
  const tokenNote =
    token.source === "configured"
      ? ""
      : token.source === "restored"
        ? "  (restored)"
        : token.persisted
          ? "  (generated, saved)"
          : "  (generated — set RIPIENO_DATA_DIR to keep it across restarts)";

  const lines = [
    "",
    "  Ripieno relay ready",
    "",
    `    URL     ${url}${observed ? "" : "   (guessed — set RIPIENO_PUBLIC_URL if wrong)"}`,
    `    Token   ${token.token}${tokenNote}`,
    `    Room    ${room}`,
    `    Members ${requireGithub ? "verified against GitHub" : "unverified — anyone may claim any handle"}`,
    "",
    "  Put the URL and token into Ripieno's settings, join the room, then use",
    "  Copy Invite Link to bring in anyone else.",
    "",
  ];
  return lines.join("\n");
}
