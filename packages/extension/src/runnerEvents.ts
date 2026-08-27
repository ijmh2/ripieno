// What a running turn is observably doing, in the room's own vocabulary.
//
// A provider stream is not safe material. It carries hidden reasoning, raw
// terminal output, file contents and — in a shell command or an environment
// dump — credentials. None of that may reach a room, so nothing here passes
// provider text through: an event is assembled from a closed set of phrases,
// plus at most a workspace-relative path and a sanitised tool name. The relay
// redacts and caps whatever still arrives, but the derivation is the boundary
// that matters, because a cap on a leaked secret is still a leaked secret.

import { MAX_PRESENCE_PATH_CHARS, MAX_PRESENCE_SUMMARY_CHARS } from "@ripieno/protocol";
import type { TurnUsage } from "@ripieno/protocol";

/** The observable phases a room shows. Deliberately the protocol's own set. */
export type RunnerPhase = "thinking" | "reading" | "editing" | "running" | "responding";

/**
 * One thing a turn did that the room may know about.
 *
 * `draft` is only user-facing assistant response text from a provider's known
 * output channel. Hidden reasoning, diagnostic strings, tool JSON and terminal
 * output may produce a safe phase/tool event but never a draft.
 */
export type RunnerEvent =
  | { type: "phase"; phase: RunnerPhase }
  | {
      type: "location";
      path: string;
      line?: number;
      endLine?: number;
      /** The bundled `workspace` MCP server addresses the room's one shared tree. */
      locationScope?: "shared";
    }
  | { type: "draft"; delta: string }
  | { type: "tool"; name: string; safeSummary: string }
  | { type: "complete"; text: string; usage?: TurnUsage };

/** Where a runner sends events. Optional everywhere, so old callers still work. */
export type RunnerEventSink = (event: RunnerEvent) => void;

/** What a tool does, as far as the room is concerned. */
export type ToolKind =
  | "read"
  | "search"
  | "edit"
  | "run"
  | "fetch"
  | "context-read"
  | "context-add"
  | "other";

/** Longest sanitised tool name shown. A name is metadata, not a message. */
const MAX_TOOL_NAME_CHARS = 40;

export function phaseForToolKind(kind: ToolKind): RunnerPhase {
  switch (kind) {
    case "read":
    case "search":
    case "context-read":
      return "reading";
    case "edit":
      return "editing";
    case "run":
    case "fetch":
      return "running";
    default:
      return "thinking";
  }
}

/**
 * A tool name fit to show.
 *
 * Names are provider-controlled — an MCP server can register whatever it likes
 * — so this keeps identifier characters and nothing else. Anything that would
 * need quoting to be safe is not a name worth printing.
 */
export function safeToolName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || !/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return undefined;
  return trimmed.slice(0, MAX_TOOL_NAME_CHARS);
}

/**
 * A path the room can show, relative to where this agent works.
 *
 * Absolute paths are relativised against the agent's directory and dropped
 * when they fall outside it: an agent that reads `/Users/someone/.aws/config`
 * must not announce where that person keeps their credentials, and the layout
 * of a member's home directory is not the room's business either.
 */
export function safePath(raw: unknown, cwd?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  // One line, no control characters: presence is rendered as a label.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const value = raw.trim();
  if (!value) return undefined;
  const absolute = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
  if (absolute) {
    if (!cwd) return undefined;
    const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
    if (!value.startsWith(root)) return undefined;
    const relative = value.slice(root.length);
    return relative ? relative.slice(0, MAX_PRESENCE_PATH_CHARS) : undefined;
  }
  // A relative path that climbs out of the workspace describes somewhere the
  // room cannot map, so it is not offered as a location.
  if (value.startsWith("../") || value === "..") return undefined;
  return value.slice(0, MAX_PRESENCE_PATH_CHARS);
}

/** A 1-based line, or nothing. */
export function safeLine(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

/**
 * The one place a summary is written.
 *
 * Every branch returns a phrase this file chose. The only variable parts are a
 * path that `safePath` has already vouched for and a tool name that
 * `safeToolName` has already reduced to identifier characters.
 */
export function summariseTool(kind: ToolKind, name?: string, path?: string): string {
  switch (kind) {
    case "read":
      return path ? `Reading ${path}` : "Reading a file";
    case "search":
      return "Searching the workspace";
    case "edit":
      return path ? `Editing ${path}` : "Editing a file";
    case "run":
      // Never the command itself: a shell line is the single most likely place
      // for a token, a password or somebody's private path to appear.
      return "Running a shell command";
    case "fetch":
      return "Fetching a resource over the network";
    case "context-read":
      return "Reading the room's shared context";
    case "context-add":
      return "Proposing an addition to the room's shared context";
    default:
      return name ? `Using the ${name} tool` : "Using a provider tool";
  }
}

/** What the room says an agent is doing when no tool is involved. */
export function summarisePhase(phase: RunnerPhase): string {
  switch (phase) {
    case "thinking":
      return "Working on the current turn";
    case "reading":
      return "Reading files in its workspace";
    case "editing":
      return "Editing files in its workspace";
    case "running":
      return "Running a command in its workspace";
    case "responding":
      return "Writing a reply for the room";
  }
}

/** Last-resort cap. Nothing reaching this should be provider-authored text. */
export function boundSummary(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_PRESENCE_SUMMARY_CHARS);
}

/** Build a tool event without letting a caller assemble the summary itself. */
export function toolEvent(kind: ToolKind, rawName: unknown, path?: string): RunnerEvent {
  const name = safeToolName(rawName);
  return {
    type: "tool",
    name: name ?? "tool",
    safeSummary: boundSummary(summariseTool(kind, name, path)),
  };
}
