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
  const haystack = normalise(text);

  if (haystack.includes(normalise(agent.label))) return true;
  if (containsToken(haystack, normalise(agent.handle))) return true;

  // "Mira Ellery's reviewer" → owner "mira hart", role "reviewer".
  const [owner, role] = splitLabel(agent.label);

  // The role word alone is the common shorthand, but only when distinctive:
  // "agent" matches every agent in the room and so names nobody.
  if (role && role !== "agent" && containsToken(haystack, role)) return true;

  // An owner's *first* name is how people usually address someone's agent —
  // but only alongside a word implying the agent, or "mira" in ordinary prose
  // would silently route every message to Mira's agent.
  const firstName = owner.split(/\s+/)[0];
  if (firstName && firstName.length > 2 && containsToken(haystack, firstName)) {
    return /\bagents?\b/.test(haystack) || haystack.includes(`@${firstName}`);
  }

  return false;
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
export function nextUnanswered<T extends { kind: string; text: string }>(
  entries: T[],
  me: SelfIdentity,
  others: AgentIdentity[]
): T | undefined {
  return entries.find((e) => e.kind === "human" && shouldAnswer(e.text, me, others));
}

/** Whole-word, allowing a leading @ and ordinary punctuation around it. */
function containsToken(haystack: string, token: string): boolean {
  if (!token) return false;
  return new RegExp(`(^|[^a-z0-9])@?${escapeRegExp(token)}([^a-z0-9]|$)`).test(haystack);
}

function splitLabel(label: string): [string, string] {
  const match = /^(.*?)['’]s\s+(.+)$/.exec(label);
  if (!match) return ["", normalise(label)];
  return [normalise(match[1]), normalise(match[2])];
}

function normalise(value: string): string {
  // Curly apostrophes come from display names copied out of other systems and
  // would otherwise defeat every comparison here.
  return value.toLowerCase().replace(/[’]/g, "'").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
