/** Pure parsing for room slash commands, kept outside the VS Code host. */

export interface CommandAgent {
  id: string;
  label: string;
}

export type ModelRequest =
  | { kind: "pick"; targetId?: string }
  | { kind: "set"; targetId: string; model?: string }
  | { kind: "error"; message: string };

/**
 * `/model` opens the picker. `/model <model>` changes the primary agent, while
 * a trailing agent label targets that one agent. Exact agent labels open that
 * agent's picker, so `/model reviewer` is useful without another syntax.
 */
export function resolveModelRequest(
  argument: string,
  agents: readonly CommandAgent[]
): ModelRequest {
  if (agents.length === 0) return { kind: "error", message: "You have no agents to configure." };
  const input = argument.trim();
  if (!input) return { kind: "pick" };

  const exact = agents.find((agent) => sameText(agent.label, input));
  if (exact) return { kind: "pick", targetId: exact.id };

  // Longest first: "code reviewer" must win over an agent called "reviewer".
  const labels = [...agents].sort((a, b) => b.label.length - a.label.length);
  for (const agent of labels) {
    const suffix = ` ${agent.label}`;
    if (!input.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())) continue;
    const model = input.slice(0, -suffix.length).trim();
    const parsed = parseModelValue(model);
    return parsed.ok
      ? { kind: "set", targetId: agent.id, model: parsed.value }
      : { kind: "error", message: parsed.message };
  }

  const parsed = parseModelValue(input);
  return parsed.ok
    ? { kind: "set", targetId: agents[0].id, model: parsed.value }
    : { kind: "error", message: parsed.message };
}

export function parseModelValue(
  input: string
): { ok: true; value?: string } | { ok: false; message: string } {
  const value = input.trim();
  if (value.toLocaleLowerCase() === "default") return { ok: true, value: undefined };
  if (!value) return { ok: false, message: "Enter a model name or use default." };
  if (value.length > 200) return { ok: false, message: "Model names must be 200 characters or fewer." };
  if (!/^[a-z0-9][a-z0-9._:/@+-]*$/i.test(value)) {
    return {
      ok: false,
      message: "Model names may contain letters, numbers, dots, dashes, underscores, colons, slashes, plus signs and @.",
    };
  }
  return { ok: true, value };
}

function sameText(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}
