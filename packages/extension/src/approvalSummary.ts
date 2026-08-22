/** Human-readable approval input, plus whether it shows the exact full value. */
export interface ApprovalSummary {
  text: string;
  rememberable: boolean;
}

const MAX_SUMMARY_CHARS = 600;

/**
 * Keep prompts readable without pretending a shortened view is enough for
 * standing consent. A remembered approval is offered only when every value is
 * present and no displayed value was truncated.
 */
export function summariseApprovalInput(input: unknown): ApprovalSummary {
  if (input === null || input === undefined) {
    return { text: "(no input)", rememberable: true };
  }
  if (typeof input === "string") return visible(input);
  if (typeof input !== "object") {
    return { text: String(input), rememberable: true };
  }

  const record = input as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "url"]) {
    if (typeof record[key] !== "string") continue;

    const primary = visible(record[key]);
    const rest = Object.keys(record).filter((candidate) => candidate !== key);
    const omitted = rest.length > 0;
    const extra = omitted ? `\n(plus ${rest.join(", ")})` : "";
    return {
      text: `${key}: ${primary.text}${extra}`,
      rememberable: primary.rememberable && !omitted,
    };
  }

  return visible(JSON.stringify(record, null, 2));
}

/** The host-side guard used before persisting a standing grant. */
export function canStoreStandingApproval(choice: string, rememberable: boolean): boolean {
  return choice === "always" && rememberable;
}

function visible(value: string): ApprovalSummary {
  return value.length <= MAX_SUMMARY_CHARS
    ? { text: value, rememberable: true }
    : { text: `${value.slice(0, MAX_SUMMARY_CHARS)}…`, rememberable: false };
}
