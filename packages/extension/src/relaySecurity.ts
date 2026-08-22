import { createHash } from "node:crypto";
import {
  isLoopbackHostname,
  validateRelayTransportUrl,
} from "@ripieno/relay-client";

export { isLoopbackHostname };

export type UrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** Validate a relay before any room or GitHub credential can be sent to it. */
export function validateRelayUrl(raw: string): UrlValidation {
  return validateRelayTransportUrl(raw);
}

/** Validate an OpenAI-compatible endpoint before its bearer token is sent. */
export function validateProviderBaseUrl(raw: string): UrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${raw}" is not a valid address` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "an API endpoint must start with https:// (or http:// on localhost)" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, reason: "an API endpoint must not contain a username or password" };
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    return { ok: false, reason: "an API endpoint outside this machine must use https:// to protect its API key" };
  }
  if (parsed.search || parsed.hash) {
    return { ok: false, reason: "an API endpoint must not contain a query string or fragment" };
  }
  return { ok: true, url: parsed.toString().replace(/\/$/, "") };
}

/** SecretStorage key scoped to one normalized relay, so a token cannot cross origins. */
export function roomTokenSecretKey(relayUrl: string): string {
  const checked = validateRelayUrl(relayUrl);
  if (!checked.ok) throw new Error(checked.reason);
  const digest = createHash("sha256").update(checked.url).digest("hex");
  return `ripieno.roomToken.${digest}`;
}

export function sameRelayUrl(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const a = validateRelayUrl(left);
  const b = validateRelayUrl(right);
  return a.ok && b.ok && a.url === b.url;
}

/** Legacy tokens had no origin; use one only where there is evidence it belongs. */
export function canUseLegacyRoomToken(
  savedRelayUrl: string | undefined,
  targetRelayUrl: string,
  allowFirstUse: boolean
): boolean {
  return sameRelayUrl(savedRelayUrl, targetRelayUrl) || (!savedRelayUrl && allowFirstUse);
}
