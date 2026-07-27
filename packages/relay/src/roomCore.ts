/**
 * Room core — pure logic, no I/O, no Anthropic types.
 *
 * Everything here must stay driver-agnostic: the hosted driver (one shared CMA
 * session) and the future BYO driver (N local agents) both build on these
 * functions, so nothing in this file may assume it owns the agent loop.
 */

import type { AttachedAgent, Member, RosterEntry } from "@mpa/protocol";
import { colorIndexFor } from "@mpa/protocol";

/* ------------------------------------------------------------------ */
/* Provenance envelope                                                 */
/* ------------------------------------------------------------------ */

/**
 * Wrap a member's message so the model can always tell who said it.
 *
 * A bare "[Name @handle]: text" prefix is trivially spoofable — any member
 * could open their message with a line that looks like someone else's prefix
 * and have the agent attribute it to them. Tag delimiters plus neutralising
 * the closing sequence makes that materially harder. We deliberately do NOT
 * escape all angle brackets: this is a developer tool and mangling every code
 * snippet would be a worse bug than the one we are preventing.
 */
export function envelope(member: Member, text: string): string {
  const body = neutraliseClosingTag(text);
  const name = escapeAttr(member.displayName);
  const repo = member.repo ? ` repo="${escapeAttr(member.repo)}"` : "";
  return `<message from="@${escapeAttr(member.handle)}" name="${name}"${repo}>\n${body}\n</message>`;
}

/** Defeat the obvious escape from the envelope without touching ordinary code. */
export function neutraliseClosingTag(text: string): string {
  return text.replace(/<\/\s*message\s*>/gi, "<\\/message>");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/* ------------------------------------------------------------------ */
/* Roster                                                              */
/* ------------------------------------------------------------------ */

export function toRosterEntry(
  member: Member,
  present: boolean,
  agents: AttachedAgent[] = [],
  kind?: "workspace"
): RosterEntry {
  return { ...member, kind, present, color: colorIndexFor(member.handle), agents };
}

/**
 * The roster block injected as a system message. The agent cannot address a
 * member's workspace without knowing the handles, so this is re-sent whenever
 * membership or presence changes.
 */
export function rosterPrompt(roster: RosterEntry[]): string {
  // The shared workspace is a container, not a participant. Listing it as a
  // member would invite the agent to address it as a person and to attribute
  // work to "workspace" — it is reached with the "room" target instead.
  const people = roster.filter((r) => r.kind !== "workspace");
  if (people.length === 0) {
    return "There are currently no members in this room.";
  }
  const lines = people.map((r) => {
    const repo = r.repo ? `, working in ${r.repo}` : "";
    const state = r.present ? "present" : "OFFLINE — do not address tools to them";
    // Members may run their own agents alongside you. Naming them stops you
    // mistaking another agent's message for its owner's own words.
    const agents =
      r.agents.length > 0 ? `; runs ${r.agents.map((a) => `"${a.label}"`).join(" and ")}` : "";
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
        ]
      : [];

  return [
    "Room members:",
    ...lines,
    ...mixedRoomNote,
    "",
    "Every message you receive is wrapped in a <message from=\"@handle\"> tag naming its author.",
    "Attribute facts, preferences and decisions to the member who stated them; never merge them into a single anonymous view.",
    "Workspace tools act on one member's machine and require their `handle`. Choose the handle deliberately:",
    "the member who asked, or the member who owns the file in question. Never guess, and never address an offline member.",
    "",
    "Members do not share a filesystem — each has their own working copy, and they may genuinely differ.",
    "You can read from more than one in a single turn, and comparing them is often the actual answer:",
    "when two people disagree about behaviour, read the same file from each and say what differs, rather",
    "than assuming one of them is describing the shared truth. Never present one member's file contents,",
    "test output or git state as though it were everyone's.",
    "",
    "When the member you need is offline, do not stop there. Their pushed branches are still readable from",
    "any present member's clone, so fetch and read those instead — and say which you used. \"As of Sam's",
    "last push on Tuesday\" is a useful answer; \"Sam is offline\" is not. Be explicit that it may be stale.",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* Tool addressing                                                     */
/* ------------------------------------------------------------------ */

export type AddressResult =
  | { ok: true; handle: string }
  | { ok: false; reason: string };

/**
 * Validate the `handle` the agent chose for a workspace tool call.
 *
 * `agent.custom_tool_use` carries nothing that identifies a member, so the
 * agent picks the target and we check it. On failure we return a corrective
 * message rather than a bare rejection — it goes back as an errored tool
 * result, and a specific reason is what lets the agent retry successfully
 * instead of repeating the same mistake.
 */
export function resolveTarget(roster: RosterEntry[], raw: unknown): AddressResult {
  if (typeof raw !== "string" || raw.trim() === "") {
    return {
      ok: false,
      reason:
        "Missing required `handle` parameter. Workspace tools run on one member's machine — " +
        `specify whose. Present members: ${presentList(roster)}.`,
    };
  }
  const handle = raw.trim().replace(/^@/, "");
  const match = roster.find((r) => r.handle.toLowerCase() === handle.toLowerCase());
  if (!match) {
    return {
      ok: false,
      reason: `No member with handle @${handle} in this room. Present members: ${presentList(roster)}.`,
    };
  }
  if (!match.present) {
    return {
      ok: false,
      reason:
        `@${match.handle} is offline, so their workspace cannot be reached. ` +
        `Present members: ${presentList(roster)}. Ask the room, or use a present member's workspace instead.`,
    };
  }
  return { ok: true, handle: match.handle };
}

function presentList(roster: RosterEntry[]): string {
  const present = roster.filter((r) => r.present).map((r) => `@${r.handle}`);
  return present.length > 0 ? present.join(", ") : "none";
}

/* ------------------------------------------------------------------ */
/* Event dedupe                                                        */
/* ------------------------------------------------------------------ */

export interface IdentifiedEvent {
  id?: string | null;
}

/**
 * Tracks which session events we have already handled.
 *
 * The SSE stream has no replay, so on every reconnect we fetch history and
 * overlay it on the live stream. Without dedupe the room would render the
 * entire conversation again after any blip.
 */
export class SeenEvents {
  private readonly seen = new Set<string>();

  /** Returns true the first time an id is offered, false thereafter. */
  markNew(event: IdentifiedEvent): boolean {
    // Interrupt events are documented to sometimes carry an empty id; treat
    // unidentifiable events as always-new rather than collapsing them together.
    if (!event.id) {
      return true;
    }
    if (this.seen.has(event.id)) {
      return false;
    }
    this.seen.add(event.id);
    return true;
  }

  filterNew<T extends IdentifiedEvent>(events: readonly T[]): T[] {
    return events.filter((e) => this.markNew(e));
  }

  get size(): number {
    return this.seen.size;
  }
}

/* ------------------------------------------------------------------ */
/* Idle gate                                                           */
/* ------------------------------------------------------------------ */

export type TurnDisposition =
  /** Keep consuming; the agent is still working. */
  | "continue"
  /** The turn is over. */
  | "terminal"
  /** Idle, but blocked on us — a tool result or confirmation is owed. */
  | "awaiting-action";

export interface StatusEventLike {
  type: string;
  stop_reason?: { type?: string | null } | null;
}

/**
 * Decide what a session event means for the turn.
 *
 * This is the single most common way to get a CMA client wrong: `idle` is
 * transient and fires while the session waits on *us*, so breaking on it
 * unconditionally strands every tool call. Only `terminated`, or `idle` with a
 * stop reason other than `requires_action`, actually ends the turn.
 */
export function classify(event: StatusEventLike): TurnDisposition {
  if (event.type === "session.status_terminated") {
    return "terminal";
  }
  if (event.type === "session.status_idle") {
    return event.stop_reason?.type === "requires_action" ? "awaiting-action" : "terminal";
  }
  return "continue";
}
