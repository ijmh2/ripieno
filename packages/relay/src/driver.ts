/**
 * The driver boundary.
 *
 * The room core owns membership, transcript, provenance and addressing; a
 * driver turns those into agent turns. `HostedDriver` runs one shared CMA
 * session; a future `ByoDriver` will instead expose the room to each member's
 * own local agent over MCP.
 *
 * The room must depend on this interface and never on a concrete driver — that
 * single constraint is what makes the second shipping mode a driver swap rather
 * than a rewrite. It also lets the room's fan-out be tested without touching
 * the network.
 */

import type { Member, RosterEntry, ToolProgressState } from "@ripieno/protocol";

export interface RoomDriver {
  /** Tell the agent who is in the room and who is unreachable. */
  sendRoster(roster: RosterEntry[]): Promise<void>;
  /** Forward a member's message, attributed to them. */
  say(member: Member, text: string): Promise<void>;
  /** Answer a workspace tool call the member's editor executed. */
  resolveToolCall(callId: string, content: string, isError: boolean): Promise<void>;
  /**
   * Handle of the member an outstanding call was addressed to, or undefined if
   * no such call is pending. The room uses this to reject results from anyone
   * else — and results for calls that were never issued.
   */
  ownerOfCall?(callId: string): string | undefined;
  /**
   * The addressed member's editor reporting how far it has got. Extends the
   * call's deadline to a window suited to that state.
   */
  noteToolProgress?(handle: string, callId: string, state: ToolProgressState): void;
  /** Release the underlying session, timers and stream when the room empties. */
  close?(): Promise<void>;
}
