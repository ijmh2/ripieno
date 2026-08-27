/**
 * Wire protocol shared by the relay and the VS Code extension.
 *
 * This is the contract that lets both sides be built independently. It is
 * deliberately transport-shaped (plain JSON over a WebSocket) and carries no
 * Anthropic types — the room core must never assume it owns the agent loop,
 * so that a future BYO driver can serve the same protocol.
 */

/** Stable identity for a room participant. Derived from the GitHub session. */
export interface Member {
  /** GitHub login. Unique within a room; how the agent addresses this person. */
  handle: string;
  displayName: string;
  avatarUrl?: string;
  /** Repo the member has open, e.g. "mellery/tgtbt". Helps the agent address correctly. */
  repo?: string;
}

/** One agent attached to the room, belonging to a member. */
export interface AttachedAgent {
  /** Unique within the room. Several agents may share an owner. */
  id: string;
  /** Owner's handle — the agent speaks in their colour. */
  owner: string;
  /** How it appears in the transcript, e.g. "Mira's agent" or "Mira's reviewer". */
  label: string;
  /** What the attached host can actually do; absent for older clients. */
  capability?: AgentCapability;
  /**
   * What it is doing right now, when its host has said.
   *
   * Absent means nobody reported — an agent joined over MCP has no host to
   * report for it, and "we do not know" must not render as "idle".
   */
  state?: AgentActivity;
  /**
   * Ephemeral, agent-authored presence. Unlike the Work log this is not a
   * durable claim that something happened; it is only where the agent says its
   * current attention is. The relay derives the agent identity from the socket.
   */
  activity?: AgentPresence;
}

export type AgentCapability = "conversation" | "workspace";

/**
 * An agent's activity, as the room sees it.
 *
 * Deliberately coarser than the extension's own AgentState: "attaching" and
 * "detached" are answered by presence in the roster, and a room only needs to
 * know whether waiting for this agent is worthwhile.
 */
export type AgentActivity =
  | "idle"
  | "thinking"
  | "reading"
  | "editing"
  | "running"
  | "responding"
  | "awaiting-approval";

/**
 * Bounds on one presence frame.
 *
 * Presence is ephemeral, but it is still shared state broadcast to everyone in
 * the room, so every field it carries is explicitly capped — the relay enforces
 * these, and a reporting host applies them early so it never sends what would
 * only be cut.
 */
export const MAX_PRESENCE_SUMMARY_CHARS = 240;
export const MAX_PRESENCE_PATH_CHARS = 500;

/**
 * Live reply previews are untrusted, ephemeral wire data, not transcript.
 *
 * The frame cap bounds one JSON message, the agent cap bounds one preview, and
 * the room cap bounds all previews currently visible. These are UTF-8 byte
 * limits: JavaScript character counts understate non-ASCII payloads.
 */
export const MAX_AGENT_DRAFT_FRAME_BYTES = 4_096;
export const MAX_AGENT_DRAFT_BYTES = 32_000;
export const MAX_ROOM_DRAFT_BYTES = 128_000;
export const MAX_AGENT_DRAFT_FRAMES_PER_SECOND = 20;
export const MAX_ROOM_DRAFT_FRAMES_PER_SECOND = 80;
export const AGENT_DRAFT_TTL_MS = 45_000;

/** The coordinate system an exact presence path belongs to. */
export type PresenceLocationScope = "shared" | "private";

/** A bounded, non-durable presence update shown in an agent inspector. */
export interface AgentPresence {
  phase: AgentActivity;
  /** Human-readable observable work, never hidden reasoning or raw terminal output. */
  summary?: string;
  /** Workspace-relative path when sharing an exact location is appropriate. */
  path?: string;
  /** Shared room workspace, or an owner-opted-in private workspace. */
  locationScope?: PresenceLocationScope;
  /** Optional 1-based line anchor. */
  line?: number;
  /**
   * Optional 1-based inclusive end of a range, never below `line`.
   *
   * Agents apply patches atomically rather than typing, so the honest claim is
   * "this range is being worked on", not a fabricated keystroke cursor.
   */
  endLine?: number;
  updatedAt: number;
  /**
   * Monotonic per-agent ordering value minted by the reporting host.
   *
   * Presence arrives faster than it is worth broadcasting, so hosts coalesce
   * and the relay rate-limits. Both drop frames, and a dropped frame must never
   * let an older description of the agent overwrite a newer one. The relay
   * accepts a value only when it advances; it never reads identity from it.
   */
  sequence?: number;
}

/**
 * What a member may do in a room.
 *
 * Only meaningful on a relay that verifies identity (RIPIENO_REQUIRE_GITHUB) —
 * without it a handle is self-asserted, so a role attached to one is a
 * suggestion. Enforced regardless, because the alternative is a permission
 * system that only exists in the UI.
 */
export type RoomRole = "owner" | "member" | "viewer";

/** A member plus live connection state. */
export interface RosterEntry extends Member {
  /**
   * Infrastructure rather than a person, so the UI can render it as the room's
   * workspace instead of giving a container a colour and a seat at the table.
   */
  kind?: "workspace";
  /** Absent for the shared workspace, which is not a person and holds no role. */
  role?: RoomRole;
  present: boolean;
  /** Palette index 0-7, assigned deterministically. See colorIndexFor(). */
  color: number;
  /**
   * This member's own agents, if any. A person can run several — a coder and a
   * reviewer, say — and each is a separate participant with its own context.
   */
  agents: AttachedAgent[];
}

export type TranscriptKind = "human" | "agent" | "system";

/** One rendered line in the room. The UI colours these by authorHandle. */
export interface TranscriptEntry {
  id: string;
  kind: TranscriptKind;
  /** For kind "agent" in BYO mode this is the owning member's handle. */
  authorHandle: string;
  authorName: string;
  text: string;
  /** Epoch millis. */
  ts: number;
  /**
   * Which agent said it, when several belong to one member. Lets the UI tell
   * "Mira's coder" from "Mira's reviewer" while keeping both in Mira's colour.
   */
  agentId?: string;
  /**
   * How many times this agent has spoken since a person last did. Its first
   * contribution is 1; at MAX_AGENT_HOPS its messages stop waking anyone.
   *
   * Counted by the relay per agent, with nothing in the message influencing it
   * — the whole point is a bound a participant cannot lift. Absent on human
   * messages, which are what resets every count.
   */
  hops?: number;
}

/**
 * How many times one agent may speak between two human messages before its
 * messages stop waking anyone.
 *
 * Two covers the case worth having — one agent reports, another checks it, the
 * first responds — and stops well short of the failure it replaces, which is
 * two agents answering each other until somebody notices the bill. With N
 * agents in a room the worst case is 2N messages and then silence, whatever
 * they say to each other.
 *
 * Naming is required as well as this cap: an unnamed agent message wakes nobody
 * at any depth, so the bound is the second line of defence, not the first.
 */
export const MAX_AGENT_HOPS = 2;

/** Lifecycle of the agent as far as the room is concerned. */
export type RoomStatus = "idle" | "thinking" | "awaiting-tool" | "error";

/* ------------------------------------------------------------------ */
/* Durable goals                                                       */
/* ------------------------------------------------------------------ */

/** Explicit wire/storage bounds. The relay enforces these values. */
export const MAX_GOALS = 100;
export const MAX_GOAL_TEXT_CHARS = 1_000;
export const MAX_GOAL_AUDIT_ENTRIES = 500;
export const MAX_GOAL_REQUESTS = 500;
export const MAX_GOAL_REQUEST_ID_CHARS = 128;

export type GoalStatus = "active" | "paused" | "completed";
export type GoalTransition = "pause" | "resume" | "complete";

/** A durable, relay-owned objective shared by everyone in one room. */
export interface Goal {
  /** Opaque, server-minted id. */
  id: string;
  text: string;
  /** Taken from the authenticated human connection, never from a message. */
  ownerHandle: string;
  ownerName: string;
  status: GoalStatus;
  /** Incremented on every successful transition of this goal. */
  version: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface GoalAuditEntry {
  id: string;
  goalId: string;
  requestId: string;
  actorHandle: string;
  action: "create" | GoalTransition;
  fromStatus?: GoalStatus;
  toStatus: GoalStatus;
  goalVersion: number;
  roomRevision: number;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* Durable shared room context                                        */
/* ------------------------------------------------------------------ */

export const MAX_CONTEXT_ITEMS = 200;
export const MAX_CONTEXT_TITLE_CHARS = 160;
export const MAX_CONTEXT_BODY_CHARS = 4_000;
export const MAX_CONTEXT_TAGS = 8;
export const MAX_CONTEXT_TAG_CHARS = 32;
export const MAX_CONTEXT_AUDIT_ENTRIES = 1_000;
export const MAX_CONTEXT_REQUESTS = 1_000;
export const MAX_CONTEXT_REQUEST_ID_CHARS = 128;

export type ContextKind =
  | "decision"
  | "fact"
  | "constraint"
  | "question"
  | "reference"
  | "note";
export type ContextStatus = "proposed" | "accepted" | "superseded" | "archived";

/**
 * One attributed unit of room memory.
 *
 * People create accepted context. Agent-created context starts proposed so a
 * model cannot silently turn an assertion into a durable room instruction.
 */
export interface ContextItem {
  id: string;
  kind: ContextKind;
  title: string;
  body: string;
  tags: string[];
  status: ContextStatus;
  authorHandle: string;
  authorName: string;
  authorAgentId?: string;
  authorAgentLabel?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface ContextAuditEntry {
  id: string;
  contextId: string;
  requestId: string;
  actorHandle: string;
  actorAgentId?: string;
  actorAgentLabel?: string;
  action: "create" | "edit" | "accept" | "supersede" | "archive";
  fromStatus?: ContextStatus;
  toStatus: ContextStatus;
  contextVersion: number;
  contextRevision: number;
  ts: number;
}

/* ------------------------------------------------------------------ */
/* Explicit agent handoff                                              */
/* ------------------------------------------------------------------ */

/** Relay-enforced bounds for durable handoff state and room context. */
export const HANDOFF_EXPIRY_MS = 5 * 60_000;
export const MAX_HANDOFFS = 100;
export const MAX_HANDOFF_AUDIT_ENTRIES = 500;
export const MAX_HANDOFF_REQUESTS = 500;
export const MAX_HANDOFF_REQUEST_ID_CHARS = 128;
export const MAX_HANDOFF_TASK_CHARS = 2_000;
export const MAX_HANDOFF_OUTCOME_CHARS = 2_000;
export const MAX_HANDOFF_CONTEXT_CHARS = 24_000;
export const MAX_HANDOFF_CONTEXT_TRANSCRIPT = 25;
export const MAX_HANDOFF_CONTEXT_ACTIONS = 25;
export const MAX_HANDOFF_CONTEXT_GOALS = 20;

export type HandoffStatus =
  | "pending"
  | "assigned"
  | "claimed"
  | "started"
  | "completed"
  | "failed"
  | "outcomeUnknown"
  | "declined"
  | "cancelled"
  | "expired";
export type HandoffDecision = "accept" | "decline" | "cancel" | "retry";

/**
 * A transfer of responsibility, not a transfer of provider identity.
 *
 * Provider credentials and private provider session ids are intentionally not
 * representable here. On acceptance a recipient-owned local agent starts from
 * shared room context using its own provider configuration and session.
 */
export interface HandoffOffer {
  id: string;
  /** Public server-minted correlation value. It is not an authentication secret. */
  nonce: string;
  /** The bounded task the source owner explicitly asks the recipient to take on. */
  task: string;
  sourceAgentId: string;
  sourceAgentLabel: string;
  sourceOwnerHandle: string;
  sourceOwnerName: string;
  targetHandle: string;
  targetName: string;
  status: HandoffStatus;
  /** Incremented at every durable lifecycle transition. */
  version: number;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  decidedBy?: string;
  decisionReason?: string;
  targetAgentId?: string;
  targetAgentLabel?: string;
  targetAgentCapability?: AgentCapability;
  /** Relay-minted identity for one explicitly authorised delivery attempt. */
  deliveryId?: string;
  assignedAt?: number;
  claimedAt?: number;
  startedAt?: number;
  finishedAt?: number;
  outcomeDetail?: string;
  /** Frozen bounded context, persisted before assignment is delivered. */
  continuation?: HandoffContinuationContext;
}

export interface HandoffAuditEntry {
  id: string;
  handoffId: string;
  actorHandle: string;
  action:
    | "offer"
    | "assign"
    | "claim"
    | "start"
    | "complete"
    | "fail"
    | "outcomeUnknown"
    | "retry"
    | "decline"
    | "cancel"
    | "expire";
  fromStatus?: HandoffStatus;
  toStatus: HandoffStatus;
  handoffVersion: number;
  handoffRevision: number;
  ts: number;
  reason?: string;
}

/** A bounded relay-authoritative snapshot used to continue work on another agent. */
export interface HandoffContinuationContext {
  schemaVersion: 2;
  notice: string;
  handoff: {
    id: string;
    nonce: string;
    sourceAgentId: string;
    sourceAgentLabel: string;
    sourceOwnerHandle: string;
    targetAgentId: string;
    targetAgentLabel: string;
    targetHandle: string;
    acceptedAt: number;
    task: string;
    targetCapability: AgentCapability;
  };
  transcript: TranscriptEntry[];
  actions: ActionEntry[];
  activeGoals: Goal[];
  truncated: {
    transcript: boolean;
    actions: boolean;
    goals: boolean;
    characters: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* Client → Server                                                     */
/* ------------------------------------------------------------------ */

/**
 * What a connection is.
 *
 * In hosted mode a room has one shared agent and every connection is a human.
 * In BYO mode each member also connects their own local agent, which posts on
 * their behalf — so a handle can have two live connections with different roles.
 */
/**
 * "workspace" is the room's shared filesystem — a container, not a person. It
 * serves the same remote tool requests a member's laptop serves, which is what
 * lets the shared workspace outlive everyone in the room.
 */
export type ConnectionRole = "human" | "agent" | "workspace";

/**
 * The handle the shared workspace joins under.
 *
 * Reserved: no person may claim it, because a connection holding this handle is
 * trusted to say what every file in the room contains.
 */
export const WORKSPACE_HANDLE = "workspace";

export interface JoinMsg {
  t: "join";
  room: string;
  member: Member;
  /** Defaults to "human" when omitted. */
  role?: ConnectionRole;
  /**
   * Role "agent" only. Identifies *which* of the member's agents this is, so one
   * person can run several at once without them evicting each other. Omitted for
   * humans, and defaulted by the relay if an agent does not supply one.
   */
  agentId?: string;
  /** Role "agent" only. Transcript label, e.g. "Mira's reviewer". */
  agentLabel?: string;
  /** Role "agent" only. Declared capability used to keep continuation prompts honest. */
  agentCapability?: AgentCapability;
  /**
   * Shared secret, when the relay is configured with one.
   *
   * This is a gate, not authentication: it stops a publicly reachable relay
   * being open to anyone who finds the URL, but it does not establish who a
   * member is — a holder of the secret can still claim any handle. Deployed
   * relays that need attribution as fact must enable GitHub verification.
   */
  token?: string;
  /**
   * Role "workspace" only: the container's own secret, never the room token.
   *
   * Separate because everyone in a room holds the room token, and a connection
   * serving the shared workspace is trusted to say what every file contains.
   */
  workspaceToken?: string;
  /**
   * A GitHub token proving who this is, when the relay requires one.
   *
   * `read:user` scope — enough for the relay to ask GitHub for a login, and
   * nothing more. Without it the handle is whatever the client claims, which
   * makes every attribution in the room a claim rather than a fact.
   */
  githubToken?: string;
}

export interface SayMsg {
  t: "say";
  text: string;
}

/** Result of a workspace tool the agent addressed to this member. */
export interface ToolResultMsg {
  t: "toolResult";
  callId: string;
  content: string;
  isError?: boolean;
}

/**
 * How far a member's editor has got with a tool call.
 *
 * The relay cannot tell "this member has vanished" from "this member is reading
 * a confirmation dialog" from "this command is legitimately slow" — and those
 * deserve wildly different patience. Each report resets the relay's deadline to
 * a window suited to the state, so a human taking a minute to click Run no
 * longer loses a race against a fixed timer.
 */
export type ToolProgressState = "received" | "awaiting-approval" | "running";

export interface ToolProgressMsg {
  t: "toolProgress";
  callId: string;
  state: ToolProgressState;
}

export interface PingMsg {
  t: "ping";
}

/**
 * An agent asking to act on *another member's* workspace.
 *
 * This is what makes a shared workspace possible across machines. A local agent
 * — Claude Code, Codex — runs tools on the filesystem it runs on; no amount of
 * configuration makes Sam's CLI write to Mira's disk. So the request travels:
 * agent → relay → the target member's editor, which executes it under that
 * member's permissions and with their approval, and sends the result back.
 */
export interface RemoteToolMsg {
  t: "remoteTool";
  /** Correlates the reply; unique per requesting connection. */
  requestId: string;
  /** Whose workspace to act on. */
  targetHandle: string;
  name: string;
  input: Record<string, unknown>;
}

/** The target member's editor answering a RemoteToolMsg. */
export interface RemoteToolResultMsg {
  t: "remoteToolResult";
  requestId: string;
  /** Who asked, so the relay can route the answer back. */
  requesterAgentId: string;
  content: string;
  isError?: boolean;
}

/**
 * The host telling the room its files changed.
 *
 * The action log only records work routed *through* the room, so an agent
 * writing with its own local tools — or the host simply saving a file — was
 * invisible to everyone else, and their cached view of the workspace silently
 * went stale. Watching the host's own filesystem catches both.
 */
export interface WorkspaceChangedMsg {
  t: "workspaceChanged";
  /** Workspace-relative paths that were created, changed or deleted. */
  paths: string[];
}

/** A member offering their workspace as the room's shared one. */
/**
 * What one turn cost.
 *
 * Every field is optional because providers differ in what they will tell you,
 * and an absent number must stay absent rather than becoming a zero — "this
 * agent cost nothing" and "this provider does not say" are very different
 * claims to put in front of someone.
 */
export interface TurnUsage {
  /** US dollars, when the provider reports a figure. */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Cached reads, which is where the shared-context saving actually shows up. */
  cacheReadTokens?: number;
  /** Model turns inside this one room turn — an agent may loop several times. */
  modelTurns?: number;
  durationMs?: number;
}

/** Everything one agent has spent in this room. */
export interface AgentUsage {
  agentId: string;
  agentLabel: string;
  owner: string;
  /**
   * Which provider produced these numbers.
   *
   * Kept so nothing ever sums dollars from one provider against tokens from
   * another and presents the result as a total.
   */
  provider: string;
  /** Room turns counted, whether or not the provider reported anything. */
  turns: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  /** This provider reports no usage at all. Say so rather than showing zero. */
  unreported?: boolean;
}

/** An agent reporting what its last turn cost. */
export interface AgentUsageMsg {
  t: "agentUsage";
  provider: string;
  usage: TurnUsage;
}

/**
 * An agent telling the room whether it is working.
 *
 * Sent on the agent's own connection, so it can only ever describe itself —
 * the relay reads who this is from the socket rather than from the message.
 */
export interface AgentStateMsg {
  t: "agentState";
  state: AgentActivity;
}

/**
 * Rich ephemeral presence. The relay supplies identity and timestamp.
 *
 * `sequence` orders one agent's own frames and nothing else: the socket still
 * chooses which agent this is, and the relay's own rate limit is measured in
 * time, so a forged sequence cannot attribute presence elsewhere or buy an
 * agent a higher publication rate.
 */
export interface AgentActivityMsg {
  t: "agentActivity";
  phase: AgentActivity;
  summary?: string;
  path?: string;
  /** Required for a path. Undefined clients retain coarse presence only. */
  locationScope?: PresenceLocationScope;
  line?: number;
  endLine?: number;
  sequence?: number;
}

/**
 * One user-visible response fragment from the authenticated agent socket.
 *
 * There is deliberately no agent id or entry id here. The relay derives the
 * former from the socket and mints the latter, then reuses it for final `say`.
 */
export interface AgentDraftMsg {
  t: "agentDraft";
  delta: string;
  /** Positive, monotonically increasing for this agent connection. */
  sequence: number;
}

/** Withdraw any incomplete preview owned by this authenticated agent. */
export interface AgentDraftCancelMsg {
  t: "agentDraftCancel";
}

/** The room's running totals, per agent. */
export interface UsageMsg {
  t: "usage";
  agents: AgentUsage[];
}

/** The owner changing what somebody may do. */
export interface SetRoleMsg {
  t: "setRole";
  handle: string;
  role: RoomRole;
}

export interface ClaimWorkspaceMsg {
  t: "claimWorkspace";
  /** False releases it. */
  claim: boolean;
}

export interface GoalCreateMsg {
  t: "goalCreate";
  /** Client retry key. It identifies this exact mutation, not the goal. */
  requestId: string;
  text: string;
}

export interface GoalTransitionMsg {
  t: "goalTransition";
  requestId: string;
  goalId: string;
  action: GoalTransition;
  /** Optimistic concurrency guard from the latest authoritative snapshot. */
  expectedVersion: number;
}

export interface ContextCreateMsg {
  t: "contextCreate";
  requestId: string;
  kind: ContextKind;
  title: string;
  body: string;
  tags?: string[];
}

/**
 * Edit content or make one lifecycle transition, guarded by the latest item
 * version. Combining the two is refused so an acceptance can never smuggle in
 * an unseen text change.
 */
export interface ContextUpdateMsg {
  t: "contextUpdate";
  requestId: string;
  contextId: string;
  expectedVersion: number;
  title?: string;
  body?: string;
  tags?: string[];
  status?: Exclude<ContextStatus, "proposed">;
}

export interface HandoffOfferMsg {
  t: "handoffOffer";
  requestId: string;
  targetHandle: string;
  /** Optional only when the actor has exactly one present agent. */
  sourceAgentId?: string;
  task: string;
}

export interface HandoffDecisionMsg {
  t: "handoffDecision";
  requestId: string;
  handoffId: string;
  /** Public correlation value from the authoritative offer snapshot; not authentication. */
  nonce: string;
  action: HandoffDecision;
  expectedVersion: number;
  /** Required for accept unless the recipient has exactly one present agent. */
  targetAgentId?: string;
}

/** Recipient agent proves it durably stored an assignment before source release. */
export interface HandoffClaimMsg {
  t: "handoffClaim";
  handoffId: string;
  deliveryId: string;
  expectedVersion: number;
}

/** Recipient agent reports that its local started marker is durable. */
export interface HandoffStartedMsg {
  t: "handoffStarted";
  handoffId: string;
  deliveryId: string;
  expectedVersion: number;
}

/** Correlated terminal result from the exact assigned recipient agent. */
export interface HandoffOutcomeMsg {
  t: "handoffOutcome";
  handoffId: string;
  deliveryId: string;
  outcome: "completed" | "failed" | "outcomeUnknown";
  detail?: string;
}

export type ClientMsg =
  | JoinMsg
  | SayMsg
  | ToolResultMsg
  | ToolProgressMsg
  | RemoteToolMsg
  | RemoteToolResultMsg
  | ClaimWorkspaceMsg
  | SetRoleMsg
  | AgentUsageMsg
  | AgentStateMsg
  | AgentActivityMsg
  | AgentDraftMsg
  | AgentDraftCancelMsg
  | WorkspaceChangedMsg
  | GoalCreateMsg
  | GoalTransitionMsg
  | ContextCreateMsg
  | ContextUpdateMsg
  | HandoffOfferMsg
  | HandoffDecisionMsg
  | HandoffClaimMsg
  | HandoffStartedMsg
  | HandoffOutcomeMsg
  | PingMsg;

/* ------------------------------------------------------------------ */
/* Server → Client                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which driver is running the room's agent. The same product has very different
 * capability in each mode, so a room must never leave this ambiguous.
 */
export type RoomMode = "hosted" | "byo";

export interface JoinedMsg {
  t: "joined";
  room: string;
  mode: RoomMode;
  /**
   * The member offering their workspace as the room's shared one, if any.
   * Agents pointed at "the room" act there rather than on their owner's machine.
   */
  workspaceHost?: string;
  /** Work already done in this room, so a joiner is not starting blind. */
  actions?: ActionEntry[];
  /** Per-agent spend so far, so a joiner sees the room's cost immediately. */
  usage?: AgentUsage[];
  /** Authoritative durable goal snapshot. */
  goals?: Goal[];
  goalAudit?: GoalAuditEntry[];
  roomRevision?: number;
  /** Authoritative durable shared context snapshot. */
  context?: ContextItem[];
  contextAudit?: ContextAuditEntry[];
  contextRevision?: number;
  /** Authoritative durable handoff snapshot. */
  handoffs?: HandoffOffer[];
  handoffAudit?: HandoffAuditEntry[];
  handoffRevision?: number;
  you: RosterEntry;
  /**
   * Agent connections only: the id the relay gave this agent.
   *
   * It is namespaced by owner rather than taken raw from the client, so the
   * client cannot work it out — and without it an agent cannot pick its own
   * messages out of the transcript, which is how one ends up answering itself.
   */
  youAgentId?: string;
  roster: RosterEntry[];
  /** Replayed so a joiner sees the conversation so far. */
  transcript: TranscriptEntry[];
  /** Current reply previews only. Never persisted or restored after restart. */
  drafts?: AgentDraft[];
}

export interface RosterMsg {
  t: "roster";
  roster: RosterEntry[];
  workspaceHost?: string;
}

export interface EntryMsg {
  t: "entry";
  entry: TranscriptEntry;
}

/** One relay-owned, non-durable reply preview. */
export interface AgentDraft {
  /** Relay-minted and reused by the one final authoritative transcript entry. */
  entryId: string;
  /** Exact agent identity derived from the connection. */
  agentId: string;
  authorHandle: string;
  authorName: string;
  /** Accumulated user-facing text, bounded in UTF-8 bytes by the relay. */
  text: string;
  /** Relay timestamp of the most recently accepted fragment. */
  updatedAt: number;
}

/** Incremental agent text (live preview). Reconciled by the final EntryMsg. */
export interface AgentDeltaMsg {
  t: "agentDelta";
  /** Matches the id of the TranscriptEntry that will arrive when complete. */
  entryId: string;
  text: string;
  /** Present for BYO drafts; optional keeps older hosted-driver frames valid. */
  agentId?: string;
  authorHandle?: string;
  authorName?: string;
}

/**
 * A workspace tool call the agent addressed to *this* member. The extension
 * executes it locally, under this user's own permissions, and replies with
 * ToolResultMsg.
 */
/**
 * A live preview ended without ever producing a final message — the model
 * request was interrupted or errored. Clients must drop the partial bubble;
 * leaving it up shows text that is in nobody's transcript, so a member who
 * reloads or joins later sees a different conversation from everyone else.
 */
export interface AgentDeltaCancelMsg {
  t: "agentDeltaCancel";
  entryId: string;
}

/**
 * One thing an agent did to a workspace, for everyone — and every other agent —
 * to see.
 *
 * Kept separate from the chat transcript on purpose: it is a record of *work*,
 * not conversation, and it is what lets a second agent say "the reviewer already
 * ran the tests and they failed" instead of running them again. It is also the
 * attribution trail that makes a shared workspace defensible rather than a
 * shared login — every entry names the acting agent, not the machine's owner.
 */
export interface ActionEntry {
  id: string;
  /** The agent that acted, not the member whose machine ran it. */
  agentId: string;
  agentLabel: string;
  /** The member whose workspace was touched. */
  targetHandle: string;
  /** read | wrote | ran | searched … */
  verb: string;
  /** Path, command, or whatever the verb acted on. */
  target: string;
  /** Short outcome: "+41 −6", "failed", "3 matches". */
  detail?: string;
  ok: boolean;
  ts: number;
}

export interface ActionMsg {
  t: "action";
  entry: ActionEntry;
}

/** Broadcast of the host's file changes, so other members drop stale reads. */
export interface WorkspaceInvalidatedMsg {
  t: "workspaceInvalidated";
  paths: string[];
}

/** A remote tool request arriving at the member who must execute it. */
export interface RemoteToolRequestMsg {
  t: "remoteToolRequest";
  requestId: string;
  /** Routed back with the result. */
  requesterAgentId: string;
  requesterLabel: string;
  /** The member who owns the requesting agent — who to blame, and to thank. */
  requesterHandle: string;
  name: string;
  input: Record<string, unknown>;
}

/** The answer travelling back to the agent that asked. */
export interface RemoteToolReplyMsg {
  t: "remoteToolReply";
  requestId: string;
  content: string;
  isError?: boolean;
}

export interface ToolCallMsg {
  t: "toolCall";
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

export interface StatusMsg {
  t: "status";
  status: RoomStatus;
  /** Present when status is "awaiting-tool": whose workspace we are waiting on. */
  waitingOn?: string;
}

export interface ErrorMsg {
  t: "error";
  message: string;
}

/** Full authoritative state, broadcast after each successful goal mutation. */
export interface GoalStateMsg {
  t: "goals";
  goals: Goal[];
  goalAudit: GoalAuditEntry[];
  roomRevision: number;
}

/** Direct acknowledgement of a mutation, including durable retry results. */
export interface GoalResultMsg {
  t: "goalResult";
  requestId: string;
  ok: boolean;
  roomRevision: number;
  goal?: Goal;
  /** Current authoritative state; present on every successful acknowledgement. */
  goals?: Goal[];
  goalAudit?: GoalAuditEntry[];
  message?: string;
}

/** Full authoritative state, broadcast after every shared-context mutation. */
export interface ContextStateMsg {
  t: "context";
  context: ContextItem[];
  contextAudit: ContextAuditEntry[];
  contextRevision: number;
}

/** Direct acknowledgement, including durable idempotent retry results. */
export interface ContextResultMsg {
  t: "contextResult";
  requestId: string;
  ok: boolean;
  contextRevision: number;
  item?: ContextItem;
  context?: ContextItem[];
  contextAudit?: ContextAuditEntry[];
  message?: string;
}

/** Full authoritative state, broadcast after every handoff mutation or expiry. */
export interface HandoffStateMsg {
  t: "handoffs";
  handoffs: HandoffOffer[];
  handoffAudit: HandoffAuditEntry[];
  handoffRevision: number;
}

/** Direct acknowledgement, including durable idempotent retry results. */
export interface HandoffResultMsg {
  t: "handoffResult";
  requestId: string;
  ok: boolean;
  handoffRevision: number;
  handoff?: HandoffOffer;
  handoffs?: HandoffOffer[];
  handoffAudit?: HandoffAuditEntry[];
  message?: string;
}

/**
 * Sent only to the recipient-owned agent selected by an accepted offer.
 * Receipt authorises one local continuation run; it never restores or claims
 * to restore the source provider's private session.
 */
export interface HandoffAssignmentMsg {
  t: "handoffAssignment";
  handoffId: string;
  deliveryId: string;
  handoffVersion: number;
  context: HandoffContinuationContext;
}

/** Replayable only after claim is durable and source authority is revoked. */
export interface HandoffStartMsg {
  t: "handoffStart";
  handoffId: string;
  deliveryId: string;
  handoffVersion: number;
  context: HandoffContinuationContext;
}

/** Tells the accepted source host to stop acting; its provider state stays local. */
export interface HandoffReleasedMsg {
  t: "handoffReleased";
  handoffId: string;
  deliveryId: string;
}

export type ServerMsg =
  | JoinedMsg
  | RosterMsg
  | EntryMsg
  | AgentDeltaMsg
  | AgentDeltaCancelMsg
  | ToolCallMsg
  | RemoteToolRequestMsg
  | RemoteToolReplyMsg
  | ActionMsg
  | WorkspaceInvalidatedMsg
  | UsageMsg
  | GoalStateMsg
  | GoalResultMsg
  | ContextStateMsg
  | ContextResultMsg
  | HandoffStateMsg
  | HandoffResultMsg
  | HandoffAssignmentMsg
  | HandoffStartMsg
  | HandoffReleasedMsg
  | StatusMsg
  | ErrorMsg;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * How long a member's editor lets a shell command run before abandoning it.
 *
 * This lives in the shared contract rather than in the extension because the
 * relay's `running` deadline must stay strictly greater than it. When the two
 * were equal (both 60s), any command that legitimately took about a minute
 * could never return in time, even with instant approval.
 */
export const COMMAND_TIMEOUT_MS = 120_000;

/** Number of distinct author colours the UI provides. */
export const PALETTE_SIZE = 8;

/**
 * Deterministic colour assignment, so every client renders a given person in
 * the same colour without the server having to broadcast a mapping.
 */
export function colorIndexFor(handle: string): number {
  let h = 0;
  for (let i = 0; i < handle.length; i++) {
    h = (h * 31 + handle.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % PALETTE_SIZE;
}

/**
 * Who is in the room, as a block an agent can read.
 *
 * This lives in the protocol because both drivers need the same answer: the
 * relay builds the hosted agent's system prompt from it, and each member's own
 * AgentHost prepends it to a BYO turn. Two renderings would drift, and the
 * failure is not cosmetic — an agent that has been told a different roster from
 * the one the relay is enforcing will address tools to people who are not
 * there.
 *
 * It exists at all because an agent with no roster guesses from display names,
 * and guesses wrongly with total confidence: asked a question by a person whose
 * name reads like a label, one refused to answer them on the grounds that they
 * were an agent. It could not check. Now it can.
 */
export function describeMembers(roster: RosterEntry[]): string {
  // The shared workspace is a container, not a participant. Listing it as a
  // member invites the agent to address it as a person and to attribute work to
  // "workspace" — it is reached with the "room" target instead.
  const people = roster.filter((r) => r.kind !== "workspace");
  if (people.length === 0) {
    return "There are currently no members in this room.";
  }

  const lines = people.map((r) => {
    const repo = r.repo ? `, working in ${r.repo}` : "";
    const state = r.present ? "present" : "OFFLINE — do not address tools to them";
    // Members may run their own agents alongside you. Naming them stops you
    // mistaking another agent's message for its owner's own words, and the
    // activity stops you answering half a question because the agent that was
    // asked for the other half has not finished yet.
    const agents =
      r.agents.length > 0
        ? `; runs ${r.agents
            .map((a) => `"${a.label}"${a.state === "thinking" ? " (thinking)" : ""}`)
            .join(" and ")}`
        : "";
    return `- @${r.handle} (${r.displayName}${repo}) — ${state}${agents}`;
  });

  const agentCount = people.reduce((n, r) => n + r.agents.length, 0);
  const mixedRoomNote =
    agentCount > 0
      ? [
          "",
          "Some members have their own agents in this room. Their messages are labelled with the agent's",
          "name, not the person's. Do not treat an agent's statement as its owner's decision, and do not",
          "address workspace tools to an agent — tools run on a *member's* machine.",
          "Everyone above who is not listed as an agent is a person. Never decide from a display name that",
          "somebody is an agent and refuse them; this list is what you check.",
        ]
      : [];

  return ["Room members:", ...lines, ...mixedRoomNote].join("\n");
}
