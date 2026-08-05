/**
 * BYO driver — the room runs with no hosted agent.
 *
 * Each member attaches their own local agent (Claude Code via the MCP server in
 * `packages/mcp`), which joins the room as an `agent`-role connection, reads the
 * transcript and posts replies attributed to its owner. The relay's only job is
 * coordination, so this driver has nothing to send outbound.
 *
 * That is the whole point of the driver boundary: swapping this for
 * `HostedDriver` changes who runs the loop and nothing else. It also means BYO
 * mode needs no API key and no agent or environment resource — it costs nothing
 * beyond each member's own subscription.
 */

import type { Member, RosterEntry } from "@ripieno/protocol";
import type { RoomDriver } from "./driver.js";

export class ByoDriver implements RoomDriver {
  async sendRoster(_roster: RosterEntry[]): Promise<void> {
    // Each attached agent reads the roster on demand via the room_roster tool,
    // so there is no shared session to brief.
  }

  async say(_member: Member, _text: string): Promise<void> {
    // Nothing to forward: attached agents observe the broadcast transcript
    // directly rather than being fed messages.
  }

  async resolveToolCall(_callId: string, _content: string, _isError: boolean): Promise<void> {
    // Workspace tools are not routed through the relay in BYO mode — each
    // agent already runs on its owner's machine with its own file access.
  }
}
