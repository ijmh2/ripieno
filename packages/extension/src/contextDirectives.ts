// A structured `context_add` for a provider with no tool channel.
//
// Claude Code reaches the room's context tools over MCP, and an
// OpenAI-compatible endpoint has native function calling. A local coding CLI
// run headlessly has neither: it is handed a prompt and prints a reply. Left
// there, "every built-in provider can propose shared context" would mean
// "every provider except the recommended one".
//
// So a CLI proposes context the only way it can — in its reply, in a fenced
// block this parses out and the room never shows. The proposal is still a
// proposal: it arrives through the same relay path as any other agent-authored
// context, starts `proposed`, is attributed by the socket rather than by
// anything in the block, and needs a person to accept it. A block that a
// participant talked the model into emitting therefore buys the same thing an
// agent could already do on purpose, and nothing more.

import type { ContextKind } from "@ripieno/protocol";
import { MAX_CONTEXT_BODY_CHARS, MAX_CONTEXT_TAGS, MAX_CONTEXT_TAG_CHARS, MAX_CONTEXT_TITLE_CHARS } from "@ripieno/protocol";

/** The fence a reply uses to propose room memory. */
export const CONTEXT_FENCE = "ripieno-context";

/** At most this many proposals from one turn, however many blocks it wrote. */
export const MAX_DIRECTIVES_PER_TURN = 3;

export interface ContextProposal {
  kind: ContextKind;
  title: string;
  body: string;
  tags?: string[];
}

export interface ExtractedDirectives {
  /** The reply with every directive block removed. */
  text: string;
  proposals: ContextProposal[];
}

const FENCE_PATTERN = new RegExp(
  "^[ \\t]*```[ \\t]*" + CONTEXT_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?[ \\t]*```[ \\t]*$",
  "gmi"
);

function validKind(value: unknown): value is ContextKind {
  return (
    value === "decision" ||
    value === "fact" ||
    value === "constraint" ||
    value === "question" ||
    value === "reference" ||
    value === "note"
  );
}

function boundedTags(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: string[] = [];
  for (const entry of value.slice(0, MAX_CONTEXT_TAGS)) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().slice(0, MAX_CONTEXT_TAG_CHARS);
    if (tag) tags.push(tag);
  }
  return tags.length > 0 ? tags : undefined;
}

/**
 * Pull every directive block out of a reply.
 *
 * Bounded at every step: the number of proposals, each field's length, and the
 * tag list. Malformed blocks are dropped rather than guessed at, but they are
 * still stripped from the text — a half-written block is machine syntax, and
 * posting it to the room under an agent's name helps nobody.
 */
export function extractContextProposals(raw: string): ExtractedDirectives {
  const proposals: ContextProposal[] = [];
  const text = raw.replace(FENCE_PATTERN, (_match, inner: string) => {
    if (proposals.length >= MAX_DIRECTIVES_PER_TURN) return "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      return "";
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    const frame = parsed as Record<string, unknown>;
    const title = typeof frame.title === "string" ? frame.title.trim() : "";
    if (!validKind(frame.kind) || !title) return "";
    proposals.push({
      kind: frame.kind,
      title: title.slice(0, MAX_CONTEXT_TITLE_CHARS),
      body:
        typeof frame.body === "string" ? frame.body.trim().slice(0, MAX_CONTEXT_BODY_CHARS) : "",
      tags: boundedTags(frame.tags),
    });
    return "";
  });
  return { text: text.replace(/\n{3,}/g, "\n\n").trim(), proposals };
}

/**
 * How the directive is explained to a provider that needs it.
 *
 * Stated as an available action rather than an instruction to use it: an agent
 * that proposes room memory on every turn is noise, and a person has to read
 * each one.
 */
export function describeContextDirective(): string {
  return [
    `To propose something for the room's shared context, put a fenced block in your reply:`,
    "```" + CONTEXT_FENCE,
    `{"kind":"decision","title":"short title","body":"detail","tags":["optional"]}`,
    "```",
    `Kinds are decision, fact, constraint, question, reference or note. At most ${MAX_DIRECTIVES_PER_TURN} per`,
    `reply. The block is removed before your reply is posted, and what it proposes stays unverified`,
    `until a person accepts it. Use it for something the room should remember, not for chat.`,
  ].join("\n");
}
