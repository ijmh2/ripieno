// Resolves the current VS Code user to a room Member. Identity comes from
// the GitHub auth session (same pattern as repopulse's github.ts) so the
// relay can address people by their real handle without us running any
// account system of our own.

import * as vscode from "vscode";
import type { Member } from "@mpa/protocol";
import { resolveGitApi } from "./gitApi";

const GITHUB_PROVIDER = "github";
const SCOPES = ["read:user"];
const API = "https://api.github.com";

interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
}

/**
 * Development-only identity override, so a second Extension Development Host
 * can join a room as somebody else without a second GitHub account.
 *
 * This is a testing affordance, not a feature. It is safe only because the
 * relay does not authenticate members at all yet — a client can already claim
 * any handle. Closing that hole (signed identity, verified at the relay) is
 * Phase 3 work, and this override must not outlive it.
 */
function resolveOverride(): Member | undefined {
  const handle = vscode.workspace
    .getConfiguration("mpa")
    .get<string>("devIdentityOverride", "")
    .trim();
  if (!handle) {
    return undefined;
  }
  const name = vscode.workspace
    .getConfiguration("mpa")
    .get<string>("devDisplayNameOverride", "")
    .trim();
  return { handle, displayName: name || handle };
}

/**
 * Resolve a Member for the signed-in GitHub user. Silent by default so
 * activation never nags; pass silent=false only in response to an explicit
 * user action (mpa.joinRoom, mpa.signIn). Returns undefined if there is no
 * session and none was requested (or the user declined the prompt).
 */
export async function resolveIdentity(silent = true): Promise<Member | undefined> {
  const override = resolveOverride();
  if (override) {
    return override;
  }

  const session = await vscode.authentication.getSession(GITHUB_PROVIDER, SCOPES, {
    createIfNone: !silent,
    silent,
  });
  if (!session) {
    return undefined;
  }

  const profile = await fetchGithubProfile(session);
  const repo = await resolveRepo();

  return {
    handle: profile.handle,
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    repo,
  };
}

async function fetchGithubProfile(
  session: vscode.AuthenticationSession
): Promise<{ handle: string; displayName: string; avatarUrl?: string }> {
  try {
    const res = await fetch(`${API}/user`, {
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MultiplayerAgent",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub GET /user → ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as GhUser;
    return {
      handle: data.login,
      displayName: data.name ?? data.login,
      avatarUrl: data.avatar_url,
    };
  } catch {
    // Network hiccup or scope issue — fall back to what the auth session
    // already told us rather than failing the whole join.
    return { handle: session.account.label, displayName: session.account.label };
  }
}

/** Best-effort "owner/repo" for the first open git repository's origin remote. */
async function resolveRepo(): Promise<string | undefined> {
  try {
    const git = await resolveGitApi();
    const repo = git?.repositories[0];
    if (!repo) {
      return undefined;
    }
    const origin =
      repo.state.remotes.find((r) => r.name === "origin") ?? repo.state.remotes[0];
    const url = origin?.fetchUrl ?? origin?.pushUrl;
    return url ? parseRepoSlug(url) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse "owner/repo" out of a git remote URL. Handles both
 * https://github.com/owner/repo(.git) and git@github.com:owner/repo.git.
 */
function parseRepoSlug(url: string): string | undefined {
  const trimmed = url.trim().replace(/\.git$/, "");

  const sshMatch = trimmed.match(/^(?:ssh:\/\/)?[^@]+@([^:/]+)[:/](.+)$/);
  if (sshMatch) {
    return fromPath(sshMatch[2]);
  }

  try {
    const u = new URL(trimmed);
    return fromPath(u.pathname.replace(/^\//, ""));
  } catch {
    return undefined;
  }
}

function fromPath(path: string): string | undefined {
  const parts = path.split("/").filter(Boolean);
  return parts.length < 2 ? undefined : `${parts[0]}/${parts[1]}`;
}
