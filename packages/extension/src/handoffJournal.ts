import type { LocalHandoffDelivery } from "./agentHost";

export const MAX_HANDOFF_JOURNAL_RECEIPTS = 2_048;
export type HandoffJournal = Record<string, LocalHandoffDelivery>;

/** Terminal deliveries need their receipt, not another copy of the room. */
export function compactHandoffDelivery(delivery: LocalHandoffDelivery): LocalHandoffDelivery {
  if (delivery.status === "assigned" || delivery.status === "started") {
    return structuredClone(delivery);
  }
  return {
    handoffId: delivery.handoffId,
    deliveryId: delivery.deliveryId,
    handoffVersion: delivery.handoffVersion,
    status: delivery.status,
    updatedAt: delivery.updatedAt,
    ...(delivery.detail !== undefined ? { detail: delivery.detail.slice(0, 2_000) } : {}),
  };
}

/**
 * Never evict a receipt to make room: a late delivery replay must still dedupe.
 * Old oversized journals remain readable and updatable, but cannot grow.
 */
export function storeHandoffDelivery(
  journal: HandoffJournal,
  key: string,
  delivery: LocalHandoffDelivery
): HandoffJournal {
  if (!Object.hasOwn(journal, key) && Object.keys(journal).length >= MAX_HANDOFF_JOURNAL_RECEIPTS) {
    throw new Error("The local handoff receipt store is full. New handoffs are paused to preserve replay protection.");
  }
  const compacted: HandoffJournal = {};
  for (const [receiptKey, receipt] of Object.entries(journal)) {
    compacted[receiptKey] = compactHandoffDelivery(receipt);
  }
  compacted[key] = compactHandoffDelivery(delivery);
  return compacted;
}
