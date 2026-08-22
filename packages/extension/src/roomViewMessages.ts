/**
 * The runtime boundary between the room webview and the extension host.
 *
 * TypeScript types do not survive `postMessage`, so every value from the
 * webview is treated as unknown here. Keep command selection in the host: the
 * webview may request one of a very small set of product actions, but it never
 * supplies a VS Code command id or arguments.
 */

export const MAX_COMPOSER_CHARS = 32_000;
const MAX_APPROVAL_ID_CHARS = 128;

export type RoomViewMessage =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "approvalVerdict"; id: string; choice: "once" | "always" | "deny" }
  | { type: "onboardingAction"; action: "joinRoom" | "attachAgent" };

export type OnboardingAction = Extract<RoomViewMessage, { type: "onboardingAction" }>["action"];
export type OnboardingCommand = "ripieno.joinRoom" | "ripieno.attachAgent";

interface OnboardingState {
  room?: string;
  you?: {
    role?: "owner" | "member" | "viewer";
    agents?: readonly unknown[];
  };
}

/** Return a validated, normalised message, or undefined for anything unknown. */
export function parseRoomViewMessage(value: unknown): RoomViewMessage | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;

  switch (value.type) {
    case "ready":
      return hasExactKeys(value, ["type"]) ? { type: "ready" } : undefined;

    case "send": {
      if (!hasExactKeys(value, ["type", "text"]) || typeof value.text !== "string") {
        return undefined;
      }
      if (value.text.length > MAX_COMPOSER_CHARS) return undefined;
      const text = value.text.trim();
      return text.length > 0 ? { type: "send", text } : undefined;
    }

    case "approvalVerdict":
      if (
        !hasExactKeys(value, ["type", "id", "choice"]) ||
        typeof value.id !== "string" ||
        value.id.length === 0 ||
        value.id.length > MAX_APPROVAL_ID_CHARS ||
        (value.choice !== "once" && value.choice !== "always" && value.choice !== "deny")
      ) {
        return undefined;
      }
      return { type: "approvalVerdict", id: value.id, choice: value.choice };

    case "onboardingAction":
      if (
        !hasExactKeys(value, ["type", "action"]) ||
        (value.action !== "joinRoom" && value.action !== "attachAgent")
      ) {
        return undefined;
      }
      return { type: "onboardingAction", action: value.action };

    default:
      return undefined;
  }
}

/**
 * Map an allowed product action to a fixed command after checking authoritative
 * extension-host state. Undefined means the request must be ignored.
 */
export function onboardingCommandFor(
  action: OnboardingAction,
  state: OnboardingState
): OnboardingCommand | undefined {
  if (action === "joinRoom") {
    return state.room ? undefined : "ripieno.joinRoom";
  }

  const you = state.you;
  if (
    !state.room ||
    !you ||
    (you.role !== "owner" && you.role !== "member") ||
    !Array.isArray(you.agents) ||
    you.agents.length > 0
  ) {
    return undefined;
  }
  return "ripieno.attachAgent";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
