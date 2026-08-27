import type {
  ActionEntry,
  AgentActivity,
  AgentCapability,
  AgentPresence,
  AgentUsage,
  Goal,
  HandoffOffer,
  RoomMode,
  RoomStatus,
  RosterEntry,
} from "@ripieno/protocol";
import type { ConnectionState } from "@ripieno/relay-client";

/**
 * Configuration visible only inside the owning member's extension host.
 *
 * None of these fields travel through the relay. The panel model attaches one
 * only after matching the relay's exact namespaced id to the signed-in owner,
 * so a similarly named remote agent cannot inherit local diagnostics.
 */
export interface LocalAgentPanelDetail {
  id: string;
  label: string;
  state: string;
  provider?: string;
  model?: string;
  folder?: string;
  permissions?: string;
  responseMode?: string;
  /** Owner-only opt-in; never relay-shared. */
  sharesPrivateLocation?: boolean;
}

export interface RoomPanelInput {
  room?: string;
  mode?: RoomMode;
  you?: RosterEntry;
  roster: RosterEntry[];
  transcriptCount: number;
  actions: ActionEntry[];
  goals: Goal[];
  contextCount: number;
  handoffs: HandoffOffer[];
  usage: AgentUsage[];
  localAgents: LocalAgentPanelDetail[];
  workspaceHost?: string;
  /** Local-only folder label when this editor is the host. */
  localWorkspaceFolder?: string;
  status: RoomStatus;
  waitingOn?: string;
  connection: ConnectionState;
}

export interface RoomPanelAgent {
  /** Relay-authoritative exact agent identity. */
  agentId: string;
  label: string;
  ownerHandle: string;
  ownerName: string;
  ownerColor: number;
  ownerPresent: boolean;
  capability?: AgentCapability;
  state?: AgentActivity;
  activity?: AgentPresence;
  /** The extension host can map this exact coordinate to a document. */
  locationOpenable: boolean;
  statusGroup: "active" | "idle" | "unknown";
  currentTask: string;
  workingSet: string[];
  recentActions: ActionEntry[];
  usage?: AgentUsage;
  activeGoals: Goal[];
  handoffs: HandoffOffer[];
  /** Present only for an exact agent owned by `you`. Never relay-shared. */
  privateLocal?: LocalAgentPanelDetail;
}

export interface RoomPanelSnapshot {
  type: "panelSnapshot";
  room?: string;
  mode?: RoomMode;
  you?: Pick<RosterEntry, "handle" | "displayName" | "role">;
  connection: ConnectionState;
  status: RoomStatus;
  waitingOn?: string;
  memberCount: number;
  presentMemberCount: number;
  transcriptCount: number;
  actionCount: number;
  contextCount: number;
  activeGoals: Goal[];
  pendingHandoffCount: number;
  workspace: {
    state: "offline" | "saved-local" | "live-remote";
    label: string;
    detail: string;
    hostHandle?: string;
  };
  agents: RoomPanelAgent[];
}

const ACTIVE_HANDOFFS = new Set(["pending", "assigned", "claimed", "started"]);

/** Build the bounded, display-only state sent to the editor-sized Room panel. */
export function buildRoomPanelSnapshot(input: RoomPanelInput): RoomPanelSnapshot {
  const members = input.roster.filter((entry) => entry.kind !== "workspace");
  const activeGoals = input.goals.filter((goal) => goal.status === "active");
  const usageByAgent = new Map(input.usage.map((entry) => [entry.agentId, entry]));

  const agents = members.flatMap((member) =>
    (member.agents ?? []).map((agent): RoomPanelAgent => {
      const recentActions = input.actions
        .filter((entry) => entry.agentId === agent.id)
        .slice(-8)
        .reverse();
      const relevantHandoffs = input.handoffs
        .filter(
          (handoff) =>
            handoff.sourceAgentId === agent.id || handoff.targetAgentId === agent.id
        )
        .slice(-6)
        .reverse();
      const liveHandoff = relevantHandoffs.find((handoff) => ACTIVE_HANDOFFS.has(handoff.status));
      const phase = agent.activity?.phase ?? agent.state;
      const currentTask =
        agent.activity?.summary ??
        liveHandoff?.task ??
        (phase && phase !== "idle"
          ? `${phase.replaceAll("-", " ")} — no task summary reported`
          : "No current task reported");

      const workingSet: string[] = [];
      if (agent.activity?.path) workingSet.push(agent.activity.path);
      for (const action of recentActions) {
        if (!workingSet.includes(action.target)) workingSet.push(action.target);
        if (workingSet.length >= 6) break;
      }

      const privateLocal = localDetailFor(input.you, agent.id, agent.owner, input.localAgents);
      return {
        agentId: agent.id,
        label: agent.label,
        ownerHandle: member.handle,
        ownerName: member.displayName || member.handle,
        ownerColor: member.color,
        ownerPresent: member.present,
        capability: agent.capability,
        state: agent.state,
        activity: agent.activity ? { ...agent.activity } : undefined,
        locationOpenable:
          Boolean(agent.activity?.path) &&
          (agent.activity?.locationScope === "shared"
            ? Boolean(input.workspaceHost)
            : agent.activity?.locationScope === "private" &&
              Boolean(privateLocal?.sharesPrivateLocation)),
        statusGroup: !phase ? "unknown" : phase === "idle" ? "idle" : "active",
        currentTask,
        workingSet,
        recentActions,
        usage: usageByAgent.get(agent.id),
        activeGoals,
        handoffs: relevantHandoffs,
        privateLocal,
      };
    })
  );

  return {
    type: "panelSnapshot",
    room: input.room,
    mode: input.mode,
    you: input.you
      ? {
          handle: input.you.handle,
          displayName: input.you.displayName,
          role: input.you.role,
        }
      : undefined,
    connection: input.connection,
    status: input.status,
    waitingOn: input.waitingOn,
    memberCount: members.length,
    presentMemberCount: members.filter((member) => member.present).length,
    transcriptCount: input.transcriptCount,
    actionCount: input.actions.length,
    contextCount: input.contextCount,
    activeGoals,
    pendingHandoffCount: input.handoffs.filter((handoff) => ACTIVE_HANDOFFS.has(handoff.status)).length,
    workspace: workspacePanelState(input),
    agents,
  };
}

function workspacePanelState(
  input: RoomPanelInput
): RoomPanelSnapshot["workspace"] {
  if (!input.room) {
    return {
      state: "offline",
      label: "Workspace offline",
      detail: "Join a room before hosting a folder.",
    };
  }
  if (input.connection !== "online") {
    return {
      state: "offline",
      label: "Workspace offline",
      detail: "The room connection is offline, so its host cannot be verified.",
    };
  }
  if (!input.workspaceHost) {
    return {
      state: "offline",
      label: "Workspace offline",
      detail: "No member is hosting a folder.",
    };
  }
  if (input.workspaceHost === input.you?.handle) {
    if (!input.localWorkspaceFolder) {
      return {
        state: "offline",
        label: "Workspace offline",
        detail: "The host claim has no open local folder and must be released.",
        hostHandle: input.workspaceHost,
      };
    }
    return {
      state: "saved-local",
      label: "Saved locally",
      detail: `${input.localWorkspaceFolder} · no durable checkpoint yet`,
      hostHandle: input.workspaceHost,
    };
  }
  return {
    state: "live-remote",
    label: `Live from @${input.workspaceHost}`,
    detail: "Available while the host is online · no durable checkpoint reported",
    hostHandle: input.workspaceHost,
  };
}

function localDetailFor(
  you: RosterEntry | undefined,
  exactAgentId: string,
  agentOwner: string,
  localAgents: LocalAgentPanelDetail[]
): LocalAgentPanelDetail | undefined {
  if (!you || agentOwner !== you.handle) return undefined;
  const detail = localAgents.find(
    (candidate) =>
      exactAgentId === candidate.id || exactAgentId === `${you.handle}::${candidate.id}`
  );
  return detail ? { ...detail } : undefined;
}
