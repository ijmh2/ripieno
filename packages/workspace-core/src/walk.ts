/**
 * Finding files without an editor.
 *
 * The extension used `vscode.workspace.findFiles`, which a container has no
 * access to. `fs.promises.glob` would be the obvious replacement but arrived in
 * Node 22, and VS Code ships Node 20 — so the extension host cannot use it
 * either, and a shared implementation has to be this one.
 *
 * One deliberate behaviour change: `findFiles` also honours the user's
 * `files.exclude` and `search.exclude` settings, and this does not. Results are
 * therefore identical between a laptop host and a container, which matters more
 * than matching a per-user editor preference that the agent never knew about.
 */

import * as path from "path";
import * as fs from "fs/promises";

/**
 * Translate a glob to a regular expression.
 *
 * Supports what the tool globs actually use: `**` across segments, `*` and `?`
 * within one, and `{a,b}` alternation. Anything else is matched literally, which
 * fails closed — an unsupported construct finds nothing rather than silently
 * matching more than the caller meant.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // `**/` spans zero or more segments, so `**/*.ts` matches `a.ts` at the
        // root as well as `src/a.ts`. Consuming the slash here is what makes the
        // "zero segments" case work.
        if (glob[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alts = glob.slice(i + 1, close).split(",");
        out += `(?:${alts.map(escapeLiteral).join("|")})`;
        i = close;
      }
    } else {
      out += escapeLiteral(ch);
    }
  }
  return new RegExp(`^${out}$`);
}

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WalkOptions {
  /** Directory names pruned during traversal, never descended into. */
  exclude: ReadonlySet<string>;
  /** Stop once this many files have matched. */
  limit: number;
}

/**
 * Every file under `base` whose path relative to `root` matches `glob`.
 *
 * Paths are matched relative to the *root* rather than to `base`, so a glob like
 * `src/**` means the same thing however the caller scoped the search.
 */
export async function walkFiles(
  root: string,
  base: string,
  glob: string,
  options: WalkOptions
): Promise<string[]> {
  const pattern = globToRegExp(glob);
  const found: string[] = [];

  async function visit(dir: string): Promise<void> {
    if (found.length >= options.limit) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole walk. A
      // permission error somewhere in a big repo should not blank the result.
      return;
    }

    for (const entry of entries) {
      if (found.length >= options.limit) return;
      const abs = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (options.exclude.has(entry.name)) continue;
        await visit(abs);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Symlinks are matched here but only survive `confineToWorkspace`, which
        // resolves them. Excluding them at this level would hide legitimate
        // in-repo links; including them without that check would leak.
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (pattern.test(rel)) found.push(abs);
      }
    }
  }

  await visit(base);
  return found.sort();
}
