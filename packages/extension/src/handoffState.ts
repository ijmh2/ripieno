import type { HandoffAuditEntry, HandoffOffer } from "@ripieno/protocol";

export interface HandoffStateSlice {
  handoffs: HandoffOffer[];
  handoffAudit: HandoffAuditEntry[];
  handoffRevision: number;
}

/** Ignore stale reconnect/live frames and clone authoritative state at the host boundary. */
export function applyHandoffState<T extends HandoffStateSlice>(
  current: T,
  handoffs: readonly HandoffOffer[],
  handoffAudit: readonly HandoffAuditEntry[],
  handoffRevision: number
): T {
  if (!Number.isSafeInteger(handoffRevision) || handoffRevision < current.handoffRevision) {
    return current;
  }
  return {
    ...current,
    handoffs: handoffs.map((handoff) => structuredClone(handoff)),
    handoffAudit: handoffAudit.map((entry) => ({ ...entry })),
    handoffRevision,
  };
}
