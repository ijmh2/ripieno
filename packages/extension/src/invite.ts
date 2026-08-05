/**
 * Joining from a link.
 *
 * Getting a second person into a room meant telling them a URL, a room code and
 * a token, and having them paste all three into settings — three chances to get
 * it wrong before anything works, and the token ends up in a settings file that
 * people commit. A link does it in one click and keeps the secret out of JSON.
 *
 * The parsing here treats the link as hostile, because it is: it arrives from a
 * browser, from a chat message, from anywhere. Nothing in it is trusted beyond
 * being shaped correctly, and the person is always shown what they are about to
 * join before it happens.
 */

export interface Invite {
  relayUrl: string;
  room: string;
  token?: string;
}

/**
 * Parse `vscode://ijmh2.ripieno/join?relay=…&room=…&token=…`.
 *
 * Returns a reason rather than throwing, because every failure here is
 * something to show a person: a link that silently does nothing is worse than
 * one that says what is wrong with it.
 */
export function parseInvite(query: string): { ok: true; invite: Invite } | { ok: false; reason: string } {
  const params = new URLSearchParams(query);
  const relay = (params.get("relay") ?? "").trim();
  const room = (params.get("room") ?? "").trim();
  const token = (params.get("token") ?? "").trim();

  if (!relay || !room) {
    return { ok: false, reason: "the link is missing the relay address or the room code" };
  }

  let parsed: URL;
  try {
    parsed = new URL(relay);
  } catch {
    return { ok: false, reason: `"${relay}" is not a valid address` };
  }

  // Only WebSocket schemes. Without this a link could point the extension at
  // file: or a scheme with side effects, and "click to join a room" is not
  // something anyone reads carefully.
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    return { ok: false, reason: `a relay address must start with ws:// or wss://, not ${parsed.protocol}` };
  }

  // The same shape the relay accepts, checked here so a bad code fails with an
  // explanation rather than a silent refusal after connecting.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(room)) {
    return { ok: false, reason: `"${room}" is not a valid room code` };
  }

  return { ok: true, invite: { relayUrl: relay, room, token: token || undefined } };
}

/**
 * Build a link to share.
 *
 * The scheme is the *product's*, not `vscode:` — this extension also runs in
 * Antigravity, Cursor and anything else built on the same base, and each
 * registers its own. Hardcoding `vscode:` produced links that silently did
 * nothing, or opened a different editor entirely, for everyone not using VS Code.
 *
 * Kept next to the parser so the two cannot drift: a generator that produces
 * something its own parser rejects is a bug nobody notices until somebody else
 * clicks the link.
 */
export function buildInvite(invite: Invite, extensionId: string, uriScheme = "vscode"): string {
  const params = new URLSearchParams({ relay: invite.relayUrl, room: invite.room });
  if (invite.token) params.set("token", invite.token);
  return `${uriScheme}://${extensionId}/join?${params.toString()}`;
}

/**
 * What to show someone before they join.
 *
 * A link carries a server address and a shared secret; clicking one should not
 * be the first time you learn where you are connecting.
 */
export function describeInvite(invite: Invite): string {
  const host = new URL(invite.relayUrl).host;
  return invite.token
    ? `Join room "${invite.room}" on ${host}? The link includes an access token.`
    : `Join room "${invite.room}" on ${host}?`;
}
