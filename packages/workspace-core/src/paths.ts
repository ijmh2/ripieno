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

  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return { ok: false, reason: "The workspace root does not exist." };
  }

  // Resolve as much of the path as exists on disk.
  //
  // This used to be a plain realpath of the target, and ENOENT was swallowed on
  // the reasoning that "the syntactic check above already ruled out escape". It
  // had not: that check ran on the *unresolved* path, so a symlinked parent went
  // unnoticed whenever the final component did not exist yet. A repository can
  // carry a committed symlink — `vendor -> /` — and one write to a new path
  // under it landed anywhere the process could reach.
  const existing = await nearestExisting(resolved);
  if (!existing) {
    return { ok: false, reason: `Path "${rawPath}" is outside the workspace.` };
  }
  if (!isInside(existing.real, realRoot)) {
    return { ok: false, reason: `Path "${rawPath}" escapes the workspace via a symlink.` };
  }

  // Hand back the *resolved* path so callers act on what was checked rather than
  // on the syntactic form, which narrows the window between check and use.
  const abs = path.join(existing.real, ...existing.missing);
  return isInside(abs, realRoot)
    ? { ok: true, abs }
    : { ok: false, reason: `Path "${rawPath}" escapes the workspace via a symlink.` };
}

/**
 * The deepest ancestor of `target` that exists, with its real path, plus the
 * segments below it that do not exist yet.
 */
async function nearestExisting(
  target: string
): Promise<{ real: string; missing: string[] } | undefined> {
  const missing: string[] = [];
  let current = target;
  // Bounded by path depth; the loop ends at the filesystem root at the latest.
  for (let i = 0; i < 256; i++) {
    try {
      return { real: await fs.realpath(current), missing: missing.slice().reverse() };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return undefined;
}

/**
 * Keep only the paths that really live inside the workspace.
 *
 * A directory walk yields paths that are *syntactically* under the root while
 * resolving outside it — a `vendor` dir pointing at $HOME, a monorepo link, or a
 * single file symlinked to something in /etc. The check has to happen before we
 * read anything, because reading is the leak.
 *
 * This used to realpath each file's *parent directory*, on the assumption that
 * containment was a property of where a file sits. It is not: a symlink lying
 * directly in the workspace root has a parent that resolves perfectly well
 * inside it, so `search` printed the contents of files `read_file` refused. The
 * inconsistency between the two was the tell.
 *
 * The directory verdict survives as a cheap pre-filter — a whole excluded tree
 * is settled once — but every path is now resolved on its own.
 */
export async function confineToWorkspace(absPaths: string[], rootAbs: string): Promise<string[]> {
  let realRoot: string;
  try {
    realRoot = await fs.realpath(rootAbs);
  } catch {
    return [];
  }

  const dirVerdicts = new Map<string, boolean>();
  const kept: string[] = [];
  for (const abs of absPaths) {
    const dir = path.dirname(abs);
    let dirOk = dirVerdicts.get(dir);
    if (dirOk === undefined) {
      try {
        dirOk = isInside(await fs.realpath(dir), realRoot);
      } catch {
        dirOk = false;
      }
      dirVerdicts.set(dir, dirOk);
    }
    if (!dirOk) continue;

    try {
      if (isInside(await fs.realpath(abs), realRoot)) kept.push(abs);
    } catch {
      // A broken link, or a race with a delete: drop it rather than read it.
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
