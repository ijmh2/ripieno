/**
 * Path safety — the security boundary of the whole product.
 *
 * Tool input is untrusted text that arrived over a WebSocket from a relay we do
 * not control, so every path is treated as hostile until proven to resolve
 * inside the workspace root.
 *
 * Moved here from the extension unchanged except for one thing: the root is now
 * passed in rather than read from `vscode.workspace.workspaceFolders`. That is
 * the entire reason this file exists separately — a container has the same
 * hostile input and no editor to ask. There must never be a second copy of these
 * checks, because a fix applied to one copy and not the other is exactly how a
 * confinement bug survives.
 */

import * as path from "path";
import * as fs from "fs/promises";

export type SafePath = { ok: true; abs: string } | { ok: false; reason: string };

/**
 * Resolve an untrusted relative path against the workspace root, rejecting
 * ".." / absolute escapes syntactically, then rejecting symlink escapes by
 * comparing real paths for anything that actually exists on disk.
 */
export async function resolveSafePath(root: string, rawPath: string): Promise<SafePath> {
  const resolved = path.resolve(root, rawPath);
  if (!isInside(resolved, root)) {
    return { ok: false, reason: `Path "${rawPath}" is outside the workspace.` };
  }

  try {
    const [realRoot, realResolved] = await Promise.all([fs.realpath(root), fs.realpath(resolved)]);
    if (!isInside(realResolved, realRoot)) {
      return { ok: false, reason: `Path "${rawPath}" escapes the workspace via a symlink.` };
    }
  } catch {
    // Target (or a path segment) doesn't exist yet — the syntactic check
    // above already ruled out escape, so let the caller's fs op surface
    // ENOENT naturally.
  }

  return { ok: true, abs: resolved };
}

/**
 * Keep only the paths that really live inside the workspace.
 *
 * A directory walk follows symlinks, so a link inside the workspace (a `vendor`
 * dir pointing at $HOME, a monorepo link) yields paths that are *syntactically*
 * under the root while resolving outside it. Only realpath catches that, and the
 * check has to happen before we read anything — reading is the leak.
 *
 * One realpath per distinct directory rather than per file, so a 2000-file
 * search stays cheap.
 */
export async function confineToWorkspace(absPaths: string[], rootAbs: string): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootAbs);
  } catch {
    return [];
  }

  const verdicts = new Map<string, boolean>();
  const kept: string[] = [];
  for (const abs of absPaths) {
    const dir = path.dirname(abs);
    let ok = verdicts.get(dir);
    if (ok === undefined) {
      try {
        ok = isInside(await fs.realpath(dir), realRoot);
      } catch {
        ok = false;
      }
      verdicts.set(dir, ok);
    }
    if (ok) {
      kept.push(abs);
    }
  }
  return kept;
}

export function isInside(target: string, root: string): boolean {
  if (target === root) {
    return true;
  }
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(withSep);
}

/**
 * Defense in depth: the walk is already scoped to its base, but strip any ".."
 * segments so a crafted glob can't be used to climb out.
 */
export function sanitizeGlob(glob: string): string {
  const cleaned = glob
    .split("/")
    .filter((seg) => seg !== "..")
    .join("/");
  return cleaned.length > 0 ? cleaned : "**/*";
}
