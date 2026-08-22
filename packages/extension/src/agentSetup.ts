/** Small, testable decisions used by the native Add Agent wizard. */

export const CODEX_SETUP_URL = "https://learn.chatgpt.com/docs/codex/cli";

export interface StoredAgentForMigration {
  id: string;
  label: string;
  brief?: string;
  cwd?: string;
  model?: string;
  providerId?: string;
  baseUrl?: string;
  command?: string;
  args?: string[];
  permissions?: "readOnly" | "workspace" | "full";
}

/**
 * Older builds silently inserted this exact Claude agent on first activation.
 * Remove it only when it is still untouched and has never created a session;
 * a real configured or previously-used agent is user data and stays put.
 */
export function isUnusedLegacyBootstrapAgent(
  agents: readonly StoredAgentForMigration[],
  sessions: Readonly<Record<string, string>>
): boolean {
  if (agents.length !== 1) return false;
  const [agent] = agents;
  return (
    agent.id === "local:default" &&
    agent.label === "agent" &&
    agent.providerId === "claude-code" &&
    !agent.brief &&
    !agent.cwd &&
    !agent.model &&
    !agent.baseUrl &&
    !agent.command &&
    (!agent.args || agent.args.length === 0) &&
    !agent.permissions &&
    !sessions[agent.id]
  );
}

/** A useful agent should appear immediately; names become optional customisation. */
export function nextAgentLabel(existing: readonly string[]): string {
  const used = new Set(existing.map((label) => label.trim().toLocaleLowerCase()));
  if (!used.has("agent")) return "agent";
  for (let number = 2; ; number += 1) {
    const candidate = `agent ${number}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * VS Code may hand a tree command either the provider's node or its rendered
 * TreeItem. Accept both, while stripping only our own room namespace.
 */
export function agentIdFromTreeNode(node: unknown, ownerHandle?: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  const candidate = node as { id?: unknown; agent?: { id?: unknown } };
  const value = candidate.agent?.id ?? candidate.id;
  if (typeof value !== "string") return undefined;
  let id = value.replace(/^(?:attached|detached):/, "");
  const ownerPrefix = ownerHandle ? `${ownerHandle}::` : undefined;
  if (ownerPrefix && id.startsWith(ownerPrefix)) id = id.slice(ownerPrefix.length);
  return id || undefined;
}

/** `codex login status` is the authority; the text protects against false-zero wrappers. */
export function isCodexLoginReady(exitCode: number | null, output: string): boolean {
  return exitCode === 0 && /(?:^|\n)\s*logged in\b/i.test(output);
}
