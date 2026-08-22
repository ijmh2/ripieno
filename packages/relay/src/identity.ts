/**
 * Proving who somebody is, rather than taking their word for it.
 *
 * Until now the handle was whatever the client sent. The room token gates who
 * may reach the relay at all, but a holder of it could join as anyone — so
 * "Mira's coder wrote room.ts" in the action log, and the matching author line
 * in `git log`, were claims rather than facts. Provenance is the product; a
 * forgeable identity makes the whole thing decorative.
 *
 * The verification is deliberately boring: the editor already holds a GitHub
 * session, so it sends that token and the relay asks GitHub who it belongs to.
 * The handle comes from GitHub's answer and never from the client.
 *
 * The cost, stated plainly because it is a real one: the relay sees a
 * `read:user`-scoped GitHub token. That is the minimum scope — it can read a
 * public profile and nothing else, it cannot touch a repository — but it is not
 * nothing, and it is the price of verified identity without running an account
 * system. A relay you do not trust should not be given one, which is the same
 * advice as for the room token it already holds.
 */

import { createHash } from "node:crypto";

const API = "https://api.github.com";
/**
 * How long a verified token is trusted without re-asking.
 *
 * Long enough that a busy room does not spend its GitHub rate limit on
 * reconnects, short enough that a revoked token stops working the same session.
 */
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface VerifiedIdentity {
  handle: string;
  displayName: string;
  avatarUrl?: string;
}

export type Verification =
  | { ok: true; identity: VerifiedIdentity }
  | { ok: false; reason: string };

interface CacheEntry {
  identity: VerifiedIdentity;
  at: number;
}

/**
 * Verifies GitHub tokens, remembering answers briefly.
 *
 * Keyed by a hash of the token rather than the token itself: this map is the
 * kind of thing that ends up in a heap dump.
 */
export class GithubVerifier {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly cacheTtlMs = CACHE_TTL_MS
  ) {}

  async verify(token: string | undefined): Promise<Verification> {
    if (!token || token.trim() === "") {
      return { ok: false, reason: "this relay requires a GitHub identity, and none was sent" };
    }

    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.cacheTtlMs) {
      return { ok: true, identity: hit.identity };
    }
    if (hit) this.cache.delete(key);

    let res: Response;
    try {
      res = await this.fetchImpl(`${API}/user`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "MultiplayerAgent",
        },
      });
    } catch (err) {
      // Deliberately fails closed. A relay that cannot check identity must not
      // hand out handles on trust — that is precisely the state this replaces.
      return {
        ok: false,
        reason: `could not reach GitHub to verify identity (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    if (res.status === 401) {
      return { ok: false, reason: "GitHub rejected that token" };
    }
    if (!res.ok) {
      return { ok: false, reason: `GitHub returned ${res.status} while verifying identity` };
    }

    const data = (await res.json()) as { login?: unknown; name?: unknown; avatar_url?: unknown };
    if (typeof data.login !== "string" || data.login === "") {
      return { ok: false, reason: "GitHub did not return a login for that token" };
    }

    const identity: VerifiedIdentity = {
      handle: data.login,
      displayName: typeof data.name === "string" && data.name !== "" ? data.name : data.login,
      avatarUrl: typeof data.avatar_url === "string" ? data.avatar_url : undefined,
    };
    const at = Date.now();
    this.cache.set(key, { identity, at });
    const expiry = setTimeout(() => {
      if (this.cache.get(key)?.at === at) this.cache.delete(key);
    }, this.cacheTtlMs);
    expiry.unref();
    this.prune();
    return { ok: true, identity };
  }

  /** Bounded, because a public relay sees an unbounded number of tokens. */
  private prune(): void {
    const cutoff = Date.now() - this.cacheTtlMs;
    for (const [key, entry] of this.cache) {
      if (entry.at < cutoff) this.cache.delete(key);
    }
    while (this.cache.size > 500) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
