import type { Goal, GoalAuditEntry } from "@ripieno/protocol";

export interface GoalViewState {
  goals: Goal[];
  goalAudit: GoalAuditEntry[];
  roomRevision: number;
}

/** Keep the extension UI monotonic across reconnect and delayed frames. */
export function applyGoalState(
  current: GoalViewState,
  goals: readonly Goal[],
  goalAudit: readonly GoalAuditEntry[],
  roomRevision: number
): GoalViewState {
  if (!Number.isSafeInteger(roomRevision) || roomRevision < current.roomRevision) return current;
  return {
    goals: goals.map((goal) => ({ ...goal })),
    goalAudit: goalAudit.map((entry) => ({ ...entry })),
    roomRevision,
  };
}
