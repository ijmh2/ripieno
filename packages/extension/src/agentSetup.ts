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

export interface CodexModelChoice {
  slug: string;
  label: string;
  description?: string;
  priority: number;
}

/** Parse `codex debug models` while tolerating a warning printed before its JSON. */
export function parseCodexModelCatalog(output: string): CodexModelChoice[] {
  const start = output.indexOf('{"models"');
  if (start < 0) return [];
  const end = output.lastIndexOf("}");
  if (end < start) return [];
  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as {
      models?: Array<{
        slug?: unknown;
        display_name?: unknown;
        description?: unknown;
        visibility?: unknown;
        priority?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.models)) return [];
    const seen = new Set<string>();
    return parsed.models
      .filter((model) => {
        if (
          typeof model.slug !== "string" ||
          model.slug.length === 0 ||
          model.visibility === "hide" ||
          seen.has(model.slug)
        ) {
          return false;
        }
        seen.add(model.slug);
        return true;
      })
      .map((model) => ({
        slug: model.slug as string,
        label:
          typeof model.display_name === "string" && model.display_name
            ? model.display_name
            : (model.slug as string),
        description:
          typeof model.description === "string" && model.description
            ? model.description
            : undefined,
        priority: typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER,
      }))
      .sort((left, right) => left.priority - right.priority || left.label.localeCompare(right.label));
  } catch {
    return [];
  }
}

/** `codex login status` is the authority; the text protects against false-zero wrappers. */
export function isCodexLoginReady(exitCode: number | null, output: string): boolean {
  return exitCode === 0 && /(?:^|\n)\s*logged in\b/i.test(output);
}
