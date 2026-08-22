import { validateRelayTransportUrl } from "@ripieno/relay-client";

/**
 * Provider-private sessions belong to one relay origin, one room and one local
 * agent. Legacy agent-only keys are deliberately not consulted or migrated.
 */
export function providerSessionScopeKey(relayUrl: string, room: string, agentId: string): string {
  const checked = validateRelayTransportUrl(relayUrl);
  if (!checked.ok) throw new Error(checked.reason);
  return ["v1", checked.url, room.trim(), agentId].map(encodeURIComponent).join(":");
}

export function handoffDeliveryScopeKey(
  relayUrl: string,
  room: string,
  agentId: string,
  deliveryId: string
): string {
  return `${providerSessionScopeKey(relayUrl, room, agentId)}:${encodeURIComponent(deliveryId)}`;
}
