// Who should answer a message.
//
// Deciding this *before* running a turn is the whole point: an agent that runs,
// reasons, and then politely says "that was meant for someone else" has already
// spent the tokens. With several agents in a room — and a room can easily hold
// one per member — that is the difference between one reply and five.
//
// Pure and separate from AgentHost so the rules can be tested directly. They are
// fiddly, they decide whether anyone answers at all, and both failure modes are
// bad: a pile-on wastes money, and silence looks like the product is broken.

import { MAX_AGENT_HOPS } from "@mpa/protocol";

export interface AgentIdentity {
  /** Transcript label, e.g. "Mira Ellery's reviewer". */
  label: string;
  /** Owner's handle, e.g. "ijmh2". */
  handle: string;
}

export interface SelfIdentity extends AgentIdentity {
  /** Answers messages that name nobody in particular. Exactly one per member. */
  primary: boolean;
}

/**
 * Should this agent answer?
 *
 * 1. Named → yes, always, whether primary or not.
 * 2. Somebody else named → no. Staying out is what stops the pile-on.
 * 3. Nobody named → the member's primary agent answers, so a plain question
 *    still gets exactly one reply per member rather than none.
 */
export function shouldAnswer(text: string, me: SelfIdentity, others: AgentIdentity[]): boolean {
  if (mentions(text, me)) return true;
  if (others.some((other) => mentions(text, other))) return false;
  return me.primary;
}

/**
 * Is this agent named in the text?
 *
 * Accepts the ways people actually write it: the full label, an @handle, the
 * owner's name, or just the distinguishing word ("reviewer"). Matching is
 * deliberately generous — a missed mention means the wrong agent answers, which
 * is worse than an extra one occasionally chiming in.
 */
export function mentions(text: string, agent: AgentIdentity): boolean {
  const haystack = normalisePossessives(normalise(text));

  if (haystack.includes(normalise(agent.label))) return true;
  if (containsName(haystack, normalise(agent.handle))) return true;

  // "Mira Ellery's reviewer" → owner "mira hart", role "reviewer".
  const [owner, role] = splitLabel(agent.label);

  // The role word alone is the common shorthand, but only when distinctive:
  // "agent" matches every agent in the room and so names nobody.
  if (role && role !== "agent" && containsToken(haystack, role)) return true;

  // Past this point only the owner's first name is left to go on, which cannot
  // distinguish one of their agents from another. So it names the *generic* one
  // and nobody else: "Mira's agent" woke Mira's reviewer too, because the text
  // contains "mira" and the word "agent" — a turn spent every time, by an agent
  // that was not asked. A distinctively named agent must be named
  // distinctively, and its role word above is how.
  if (role && role !== "agent") return false;

  // An owner's *first* name is how people usually address someone's agent —
  // but only alongside a word implying the agent, or "mira" in ordinary prose
  // would silently route every message to Mira's agent.
  const firstName = owner.split(/\s+/)[0];
  if (firstName && firstName.length > 2 && containsName(haystack, firstName)) {
    return /\bagents?\b/.test(haystack) || haystack.includes(`@${firstName}`);
  }

  return false;
}

/** The parts of a transcript entry the addressing rules read. */
export interface AddressableEntry {
  kind: string;
  text: string;
  /** Depth in a chain of agents, counted by the relay. Humans are 0. */
  hops?: number;
  /** Which agent said it, so this one does not answer itself. */
  agentId?: string;
}

/**
 * Should this agent answer this entry?
 *
 * Humans get the ordinary rules, including the primary fallback: a plain
 * question with no name in it still deserves exactly one reply.
 *
 * Another agent's message is different, and deliberately much stricter. It has
 * to *name* this agent — no primary fallback, because a fallback is precisely
 * what turns two agents into a conversation nobody asked for and nobody is
 * paying attention to. And it stops at MAX_AGENT_HOPS regardless: naming is
 * what an agent decides, so naming alone bounds nothing. One agent reporting
 * and another checking it is worth having; the third reply is where it becomes
 * a bill.
 */
export function answersEntry(
  entry: AddressableEntry,
  me: SelfIdentity,
  others: AgentIdentity[],
  myAgentId?: string
): boolean {
  if (entry.kind === "human") return shouldAnswer(entry.text, me, others);
  if (entry.kind !== "agent") return false;
  // Answering your own message is the shortest possible loop, and a label an
  // agent tends to repeat — it signs off with its own name and wakes itself.
  if (myAgentId !== undefined && entry.agentId === myAgentId) return false;
  if ((entry.hops ?? 0) >= MAX_AGENT_HOPS) return false;
  return mentions(entry.text, me);
}

/**
 * The oldest message this agent still owes an answer to.
 *
 * A turn takes time, and anything said during it has to be picked up afterwards.
 * That recovery used to look only at the *last* transcript entry, and skip it
 * unless it was a human message — so a question followed by somebody joining, or
 * by another agent replying, was silently never answered. In a room with several
 * agents that is the ordinary case rather than an edge one, and it presents as
 * the agent simply ignoring you.
 */
export function nextUnanswered<T extends AddressableEntry>(
  entries: T[],
  me: SelfIdentity,
  others: AgentIdentity[],
  myAgentId?: string
): T | undefined {
  return entries.find((e) => answersEntry(e, me, others, myAgentId));
}

/** Whole-word, allowing a leading @ and ordinary punctuation around it. */
function containsToken(haystack: string, token: string): boolean {
  if (!token) return false;
  return new RegExp(`(^|[^a-z0-9])@?${escapeRegExp(token)}([^a-z0-9]|$)`).test(haystack);
}

/**
 * Whole-word, and also the apostrophe-less possessive: "miras" names Mira.
 *
 * Only ever applied to an owner's *name*, never to a role word. Allowing it
 * everywhere made "the reviewers meeting is at 4" name the reviewer — a plural
 * is not a possessive, and conflating them wakes an agent for a diary entry.
 *
 * Without it, though, "miras agent" matched nobody, so no agent counted as named
 * and *every* primary agent answered. Seen in a real room: a question about one
 * agent woke both, and the wrong one replied. Apostrophes are exactly what
 * people drop when typing quickly.
 */
function containsName(haystack: string, name: string): boolean {
  if (!name) return false;
  return new RegExp(`(^|[^a-z0-9])@?${escapeRegExp(name)}s?([^a-z0-9]|$)`).test(haystack);
}

function splitLabel(label: string): [string, string] {
  const match = /^(.*?)['’]s\s+(.+)$/.exec(label);
  if (!match) return ["", normalise(label)];
  return [normalise(match[1]), normalise(match[2])];
}

/**
 * Strip possessive apostrophes before matching.
 *
 * "mira's agent" and "miras agent" have to be the same thing to a reader, so
 * they have to be the same thing here.
 */
function normalisePossessives(text: string): string {
  return text.replace(/['’]s\b/g, "s");
}

function normalise(value: string): string {
  // Curly apostrophes come from display names copied out of other systems and
  // would otherwise defeat every comparison here.
  return value.toLowerCase().replace(/[’]/g, "'").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
