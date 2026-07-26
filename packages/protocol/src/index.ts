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
  /** Repo the member has open, e.g. "ijmh2/tgtbt". Helps the agent address correctly. */
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
}

/** A member plus live connection state. */
export interface RosterEntry extends Member {
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
}

/** Lifecycle of the agent as far as the room is concerned. */
export type RoomStatus = "idle" | "thinking" | "awaiting-tool" | "error";

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
export type ConnectionRole = "human" | "agent";

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
  /**
   * Shared secret, when the relay is configured with one.
   *
   * This is a gate, not authentication: it stops a publicly reachable relay
   * being open to anyone who finds the URL, but it does not establish who a
   * member is — a holder of the secret can still claim any handle. Real
   * per-member identity is Phase 3 work.
   */
  token?: string;
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

/** A member offering their workspace as the room's shared one. */
export interface ClaimWorkspaceMsg {
  t: "claimWorkspace";
  /** False releases it. */
  claim: boolean;
}

export type ClientMsg =
  | JoinMsg
  | SayMsg
  | ToolResultMsg
  | ToolProgressMsg
  | RemoteToolMsg
  | RemoteToolResultMsg
  | ClaimWorkspaceMsg
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
  you: RosterEntry;
  roster: RosterEntry[];
  /** Replayed so a joiner sees the conversation so far. */
  transcript: TranscriptEntry[];
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

/** Incremental agent text (live preview). Reconciled by the final EntryMsg. */
export interface AgentDeltaMsg {
  t: "agentDelta";
  /** Matches the id of the TranscriptEntry that will arrive when complete. */
  entryId: string;
  text: string;
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
