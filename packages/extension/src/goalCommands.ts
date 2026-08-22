import type { Goal, GoalTransition } from "@ripieno/protocol";
import { MAX_GOAL_TEXT_CHARS } from "@ripieno/protocol";

export type GoalCommand =
  | { kind: "create"; text: string }
  | { kind: "list" }
  | { kind: "show"; reference: string }
  | { kind: "transition"; action: GoalTransition; reference: string }
  | { kind: "error"; message: string };

const USAGE =
  "Usage: /goal create <text> | list | show <id> | pause <id> | resume <id> | complete <id>";

/** Parse only /goal. Undefined means the composer text is not this command. */
export function parseGoalCommand(raw: string): GoalCommand | undefined {
  const trimmed = raw.trim();
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return undefined;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "error", message: USAGE };

  const firstSpace = argument.search(/\s/);
  const verb = (firstSpace < 0 ? argument : argument.slice(0, firstSpace)).toLowerCase();
  const rest = (firstSpace < 0 ? "" : argument.slice(firstSpace + 1)).trim();
  if (verb === "list") {
    return rest ? { kind: "error", message: "Usage: /goal list" } : { kind: "list" };
  }
  if (verb === "create") {
    if (!rest) return { kind: "error", message: "Usage: /goal create <text>" };
    if (rest.length > MAX_GOAL_TEXT_CHARS) {
      return {
        kind: "error",
        message: `A goal may be at most ${MAX_GOAL_TEXT_CHARS} characters.`,
      };
    }
    return { kind: "create", text: rest };
  }
  if (verb === "show" || verb === "pause" || verb === "resume" || verb === "complete") {
    if (!rest || /\s/.test(rest)) {
      return { kind: "error", message: `Usage: /goal ${verb} <id>` };
    }
    return verb === "show"
      ? { kind: "show", reference: rest }
      : { kind: "transition", action: verb, reference: rest };
  }
  return { kind: "error", message: USAGE };
}

export type GoalResolution =
  | { ok: true; goal: Goal }
  | { ok: false; message: string };

/** Accept a full opaque id or an unambiguous displayed prefix. */
export function resolveGoalReference(reference: string, goals: readonly Goal[]): GoalResolution {
  const wanted = reference.toLowerCase();
  const exact = goals.find(
    (goal) => goal.id.toLowerCase() === wanted || displayGoalId(goal.id).toLowerCase() === wanted
  );
  if (exact) return { ok: true, goal: exact };
  const matches = goals.filter((goal) => {
    const id = goal.id.toLowerCase();
    const bare = id.startsWith("goal_") ? id.slice(5) : id;
    return id.startsWith(wanted) || bare.startsWith(wanted);
  });
  if (matches.length === 1) return { ok: true, goal: matches[0]! };
  if (matches.length > 1) {
    return { ok: false, message: `Goal ID "${reference}" is ambiguous. Use /goal list.` };
  }
  return { ok: false, message: `No goal matching "${reference}". Use /goal list.` };
}

export function displayGoalId(id: string): string {
  const bare = id.startsWith("goal_") ? id.slice(5) : id;
  return bare.slice(0, 8);
}

