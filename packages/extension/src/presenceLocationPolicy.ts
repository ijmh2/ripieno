// The boundary between an observable provider path and an honest editor
// coordinate. A relative path alone is not enough: independent clones can be
// on different commits, and opening the same-looking line there would be a
// confident lie.

import * as path from "node:path";
import type { PresenceLocationScope } from "@ripieno/protocol";

export interface PresenceLocationPolicyInput {
  /** Set only for Ripieno's bundled shared-workspace MCP tools. */
  hint?: "shared";
  hasSharedWorkspace: boolean;
  ownsSharedWorkspace: boolean;
  /** Root the provider actually runs in. */
  agentRoot?: string;
  /** Root this editor offered as the room's shared workspace. */
  editorRoot?: string;
  /** Explicit local setting; false is the privacy-preserving default. */
  sharePrivateLocation: boolean;
}

/** Choose a coordinate system, or withhold the exact path entirely. */
export function presenceLocationScope(
  input: PresenceLocationPolicyInput
): PresenceLocationScope | undefined {
  if (input.hint === "shared" && input.hasSharedWorkspace) return "shared";
  if (
    input.ownsSharedWorkspace &&
    input.agentRoot &&
    input.editorRoot &&
    sameRoot(input.agentRoot, input.editorRoot)
  ) {
    return "shared";
  }
  return input.sharePrivateLocation ? "private" : undefined;
}

/** Resolve an untrusted relative presence path without escaping its root. */
export function resolvePresencePath(root: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath)) return undefined;
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  const relative = path.relative(resolvedRoot, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return target;
}

function sameRoot(left: string, right: string): boolean {
  const a = path.resolve(left).replace(/[\\/]+$/, "");
  const b = path.resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? a.toLocaleLowerCase() === b.toLocaleLowerCase() : a === b;
}
