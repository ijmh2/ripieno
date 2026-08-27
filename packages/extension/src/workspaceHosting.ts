// Pure decisions for workspace setup. Keeping these outside extension.ts makes
// the empty-window path testable without pretending VS Code has a folder open.

import * as path from "node:path";

export interface WorkingFolderChoice {
  action: "current" | "choose";
  label: string;
  description: string;
  picked?: boolean;
}

/** Never offer "this workspace" when no local folder actually exists. */
export function workingFolderChoices(currentName?: string): WorkingFolderChoice[] {
  const choices: WorkingFolderChoice[] = [];
  if (currentName) {
    choices.push({
      action: "current",
      label: `$(folder) ${currentName}`,
      description: "the folder open in this window",
      picked: true,
    });
  }
  choices.push({
    action: "choose",
    label: "$(folder-opened) Choose a folder…",
    description: "another project — create a new folder in the dialog if you need one",
    picked: !currentName,
  });
  return choices;
}

/** A readable, filesystem-safe default derived from the relay room code. */
export function roomWorkspaceName(room: string): string {
  const safe = room
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return safe || "room";
}

/** Pick a new visible directory without adopting or overwriting an old one. */
export async function availableRoomWorkspacePath(
  parent: string,
  room: string,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  const base = roomWorkspaceName(room);
  for (let suffix = 1; suffix <= 10_000; suffix += 1) {
    const name = suffix === 1 ? base : `${base}-${suffix}`;
    const candidate = path.join(parent, name);
    if (!(await exists(candidate))) return candidate;
  }
  throw new Error(`Could not find an unused folder name for ${base}.`);
}

/** Compare editor folder roots without making Windows casing a false mismatch. */
export function sameWorkspaceRoot(left: string, right: string): boolean {
  const a = path.resolve(left).replace(/[\\/]+$/, "");
  const b = path.resolve(right).replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
