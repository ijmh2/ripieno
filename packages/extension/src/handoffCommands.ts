import type { AttachedAgent, HandoffOffer } from "@ripieno/protocol";

export const HANDOFF_USAGE =
  "Usage: /handoff offer @member [source-agent] -- <task> | list | accept <id> [target-agent] | retry <id> [target-agent] | decline <id> | cancel <id>";

export type HandoffCommand =
  | { kind: "list" }
  | { kind: "offer"; targetHandle: string; sourceReference?: string; task: string }
  | { kind: "decision"; action: "accept" | "retry"; reference: string; targetReference?: string }
  | { kind: "decision"; action: "decline" | "cancel"; reference: string }
  | { kind: "error"; message: string };

/** Parse only /handoff. Undefined means the composer text is not this command. */
export function parseHandoffCommand(text: string): HandoffCommand | undefined {
  const match = /^\/handoff(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return undefined;
  const input = (match[1] ?? "").trim();
  if (!input) return { kind: "error", message: HANDOFF_USAGE };
  const verbMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)!;
  const verb = verbMatch[1]!.toLowerCase();
  const rest = (verbMatch[2] ?? "").trim();

  if (verb === "list") {
    return rest ? { kind: "error", message: "Usage: /handoff list" } : { kind: "list" };
  }
  if (verb === "offer") {
    const offer = /^@([A-Za-z0-9-_]{1,39})(?:\s+(.+?))?\s+--\s+([\s\S]+)$/.exec(rest);
    if (!offer) {
      return { kind: "error", message: "Usage: /handoff offer @member [source-agent] -- <task>" };
    }
    if (!offer[3]!.trim()) {
      return { kind: "error", message: "A handoff requires a task after --." };
    }
    return {
      kind: "offer",
      targetHandle: offer[1]!,
      sourceReference: offer[2]?.trim() || undefined,
      task: offer[3]!.trim(),
    };
  }
  if (verb === "accept" || verb === "retry") {
    const decision = /^(\S+)(?:\s+([\s\S]+))?$/.exec(rest);
    if (!decision) {
      return { kind: "error", message: `Usage: /handoff ${verb} <id> [target-agent]` };
    }
    return {
      kind: "decision",
      action: verb,
      reference: decision[1]!,
      targetReference: decision[2]?.trim() || undefined,
    };
  }
  if (verb === "decline" || verb === "cancel") {
    if (!/^\S+$/.test(rest)) {
      return { kind: "error", message: `Usage: /handoff ${verb} <id>` };
    }
    return { kind: "decision", action: verb, reference: rest };
  }
  return { kind: "error", message: HANDOFF_USAGE };
}

export function displayHandoffId(id: string): string {
  const bare = id.startsWith("handoff_") ? id.slice(8) : id;
  return bare.slice(0, 8);
}

export type HandoffResolution =
  | { ok: true; handoff: HandoffOffer }
  | { ok: false; message: string };

export function resolveHandoffReference(
  reference: string,
  handoffs: readonly HandoffOffer[]
): HandoffResolution {
  const wanted = reference.toLowerCase();
  const exact = handoffs.find(
    (handoff) =>
      handoff.id.toLowerCase() === wanted || displayHandoffId(handoff.id).toLowerCase() === wanted
  );
  if (exact) return { ok: true, handoff: exact };
  const matches = handoffs.filter((handoff) => {
    const id = handoff.id.toLowerCase();
    const bare = id.startsWith("handoff_") ? id.slice(8) : id;
    return id.startsWith(wanted) || bare.startsWith(wanted);
  });
  if (matches.length === 1) return { ok: true, handoff: matches[0]! };
  if (matches.length > 1) {
    return { ok: false, message: `Handoff ID "${reference}" is ambiguous. Use /handoff list.` };
  }
  return { ok: false, message: `No handoff matching "${reference}". Use /handoff list.` };
}

export type AgentResolution =
  | { ok: true; agent?: AttachedAgent }
  | { ok: false; message: string };

/** Resolve a relay roster agent by full id, local id suffix or exact label. */
export function resolveHandoffAgent(
  reference: string | undefined,
  agents: readonly AttachedAgent[],
  purpose: "source" | "target"
): AgentResolution {
  if (!reference) {
    if (agents.length === 1) return { ok: true, agent: agents[0] };
    if (agents.length === 0) {
      return {
        ok: false,
        message:
          purpose === "source"
            ? "Attach one of your agents before offering a handoff."
            : "Attach one of your agents before accepting this handoff.",
      };
    }
    return {
      ok: false,
      message: `Choose a ${purpose} agent by its label.`,
    };
  }
  const wanted = reference.trim().toLowerCase();
  const matches = agents.filter((agent) => {
    const localId = agent.id.includes("::") ? agent.id.slice(agent.id.lastIndexOf("::") + 2) : agent.id;
    return (
      agent.id.toLowerCase() === wanted ||
      localId.toLowerCase() === wanted ||
      agent.label.toLowerCase() === wanted
    );
  });
  if (matches.length === 1) return { ok: true, agent: matches[0] };
  if (matches.length > 1) {
    return { ok: false, message: `Agent "${reference}" is ambiguous.` };
  }
  return { ok: false, message: `No present ${purpose} agent matching "${reference}".` };
}
