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

export type AgentResponseMode = "automatic" | "mentions";

/**
 * Existing agents predate an explicit response-mode field. Preserve their
 * established behaviour: the first one answers ordinary room messages and the
 * rest wait to be named. Newly-created agents persist the same decision.
 */
export function effectiveResponseMode(
  configured: AgentResponseMode | undefined,
  index: number
): AgentResponseMode {
  return configured ?? (index === 0 ? "automatic" : "mentions");
}

/** A new second agent must not make every plain message fan out twice. */
export function responseModeForNewAgent(configuredAgentCount: number): AgentResponseMode {
  return configuredAgentCount === 0 ? "automatic" : "mentions";
}

/**
 * Provider discovery changes ordering only. It never accepts provider ids from
 * an invite or webview, and stable source ordering keeps the picker predictable.
 */
export function orderDetectedProviderIds(
  providerIds: readonly string[],
  detectedIds: readonly string[]
): string[] {
  const detected = new Set(detectedIds);
  return [
    ...providerIds.filter((id) => detected.has(id)),
    ...providerIds.filter((id) => !detected.has(id)),
  ];
}

export type SafeAgentPermission = "readOnly" | "workspace" | "full";

/**
 * Fail closed where Ripieno has a real enforcement mechanism. Other CLIs keep
 * provider-owned permissions rather than receiving a label we cannot enforce.
 */
export function safestUsablePermission(
  providerId: string,
  providerKind: "claude-code" | "cli" | "openai-compatible"
): SafeAgentPermission | undefined {
  if (providerId === "codex") return "readOnly";
  if (providerKind === "claude-code") return "workspace";
  return undefined;
}

export type OnboardingRole = "owner" | "member" | "viewer";
export type OnboardingAgentState =
  | "detached"
  | "attaching"
  | "idle"
  | "thinking"
  | "error"
  | "refused";
export type OnboardingAction = "joinRoom" | "addAgent" | "attachAgent";
export type OnboardingStepStatus = "complete" | "current" | "pending";

export interface OnboardingStep {
  label: string;
  status: OnboardingStepStatus;
}

export interface OnboardingDecision {
  steps: [OnboardingStep, OnboardingStep, OnboardingStep];
  action?: { kind: OnboardingAction; label: string };
  readOnly: boolean;
  complete: boolean;
  showAgentHelp: boolean;
}

export interface OnboardingDecisionInput {
  room?: string;
  role?: OnboardingRole;
  configuredAgents: readonly { id: string; state?: OnboardingAgentState }[];
  /** Relay-authoritative ids currently attached beneath this member. */
  attachedAgentIds?: readonly string[];
}

/**
 * One pure state machine drives both the visible three-step progress and the
 * extension-host authorization for its fixed actions.
 */
export function decideOnboarding(input: OnboardingDecisionInput): OnboardingDecision {
  if (!input.room) {
    return {
      steps: [
        { label: "Joined room", status: "current" },
        { label: "Agent needs setup", status: "pending" },
        { label: "Start collaborating", status: "pending" },
      ],
      action: { kind: "joinRoom", label: "Join room" },
      readOnly: false,
      complete: false,
      showAgentHelp: false,
    };
  }

  if (input.role === "viewer") {
    return {
      steps: [
        { label: "Joined room", status: "complete" },
        { label: "Agent unavailable to viewers", status: "complete" },
        { label: "Follow along read-only", status: "current" },
      ],
      readOnly: true,
      complete: true,
      showAgentHelp: false,
    };
  }

  const attached = new Set(input.attachedAgentIds ?? []);
  const active = input.configuredAgents.some(
    (agent) =>
      attached.has(agent.id) ||
      [...attached].some((id) => id.endsWith(`::${agent.id}`)) ||
      agent.state === "attaching" ||
      agent.state === "idle" ||
      agent.state === "thinking"
  );
  if (active) {
    return {
      steps: [
        { label: "Joined room", status: "complete" },
        { label: "Agent ready", status: "complete" },
        { label: "Start collaborating", status: "complete" },
      ],
      readOnly: false,
      complete: true,
      showAgentHelp: false,
    };
  }

  if (input.configuredAgents.length > 0) {
    return {
      steps: [
        { label: "Joined room", status: "complete" },
        { label: "Agent ready", status: "complete" },
        { label: "Start collaborating", status: "current" },
      ],
      action: { kind: "attachAgent", label: "Attach agent" },
      readOnly: false,
      complete: false,
      showAgentHelp: false,
    };
  }

  return {
    steps: [
      { label: "Joined room", status: "complete" },
      { label: "Agent needs setup", status: "current" },
      { label: "Start collaborating", status: "pending" },
    ],
    action: { kind: "addAgent", label: "Add agent" },
    readOnly: false,
    complete: false,
    showAgentHelp: true,
  };
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

/**
 * The room CTA calls Attach Agent without a target. On a true first run that
 * should enter normal Add Agent setup; an explicit but stale tree target must
 * remain a no-op instead of unexpectedly creating another agent.
 */
export function shouldStartAddAgentForAttach(
  configuredAgentCount: number,
  requestedAgentId?: string
): boolean {
  return configuredAgentCount === 0 && requestedAgentId === undefined;
}

/** A local agent gives room participants influence over this machine. */
export function needsSharedRoomAgentConsent(
  workspaceCapable: boolean,
  relayUrl: string | undefined,
  soloRelayUrl: string | undefined,
  room: string | undefined,
  alreadyConsented: boolean
): boolean {
  return Boolean(
    workspaceCapable && relayUrl && room && relayUrl !== soloRelayUrl && !alreadyConsented
  );
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
