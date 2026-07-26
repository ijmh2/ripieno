#!/usr/bin/env node
/**
 * MCP server that attaches a local agent to a shared room.
 *
 * This is BYO mode: your own Claude Code, on your own subscription, joins the
 * room as your agent. The relay needs no API key, no agent or environment
 * resource, and no credit balance — coordination only.
 *
 * stdout is the MCP protocol channel, so every diagnostic goes to stderr.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TranscriptEntry } from "@mpa/protocol";
import { RoomClient } from "./roomClient.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[mpa-mcp] missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

const client = new RoomClient({
  url: process.env.MPA_RELAY_URL ?? "ws://localhost:8787",
  room: required("MPA_ROOM"),
  handle: required("MPA_HANDLE"),
  displayName: process.env.MPA_NAME ?? required("MPA_HANDLE"),
  repo: process.env.MPA_REPO,
});

/** Render entries the way the agent should read them: authored, never anonymous. */
function format(entries: TranscriptEntry[]): string {
  if (entries.length === 0) return "(nothing new in the room)";
  return entries
    .map((e) => {
      const when = new Date(e.ts).toISOString().slice(11, 19);
      if (e.kind === "system") return `[${when}] — ${e.text}`;
      return `[${when}] ${e.authorName} (@${e.authorHandle}):\n${e.text}`;
    })
    .join("\n\n");
}

const server = new McpServer({ name: "multiplayer-agent-room", version: "0.0.1" });

server.registerTool(
  "room_read",
  {
    title: "Read the room",
    description:
      "Read messages from the shared room. Returns only what you have not seen since your last read, " +
      "so call it whenever you want to catch up. Every message is labelled with its author — attribute " +
      "facts and opinions to the person who said them, and never merge the members into one view.",
    inputSchema: {
      all: z
        .boolean()
        .optional()
        .describe("Return the full recent history instead of only unseen messages."),
      limit: z.number().int().min(1).max(200).optional().describe("Max messages when all=true."),
    },
  },
  async ({ all, limit }) => {
    await client.connect();
    const entries = all ? client.recent(limit ?? 50) : client.takeNew();
    return { content: [{ type: "text", text: format(entries) }] };
  }
);

server.registerTool(
  "room_post",
  {
    title: "Post to the room",
    description:
      "Post a message to the shared room. Everyone in the room sees it, attributed to you as its author's " +
      "agent. Use this to answer a question directed at you or your owner, or to share something the room " +
      "needs. Keep it brief — several people are reading.",
    inputSchema: {
      text: z.string().min(1).describe("The message to post."),
    },
  },
  async ({ text }) => {
    await client.connect();
    const delivered = await client.post(text);
    return {
      content: [
        {
          type: "text",
          text: delivered
            ? "Posted to the room."
            : "NOT posted — the room did not acknowledge the message. Do not assume the members saw it; try again.",
        },
      ],
      isError: !delivered,
    };
  }
);

server.registerTool(
  "room_roster",
  {
    title: "Who is in the room",
    description:
      "List the room's members, whether each is currently present, and whether they have their own agent " +
      "attached. Check this before assuming who you are talking to.",
    inputSchema: {},
  },
  async () => {
    await client.connect();
    const roster = client.currentRoster();
    const text =
      roster.length === 0
        ? "(the room is empty)"
        : roster
            .map((r) => {
              const state = r.present ? "present" : "away";
              // A member may run several agents; name them so the room can tell
              // "Mira's coder" from "Mira's reviewer".
              const agents =
                r.agents.length > 0 ? `, agents: ${r.agents.map((a) => a.label).join(", ")}` : "";
              const repo = r.repo ? `, in ${r.repo}` : "";
              return `- ${r.displayName} (@${r.handle}) — ${state}${agents}${repo}`;
            })
            .join("\n");
    return { content: [{ type: "text", text }] };
  }
);

async function main(): Promise<void> {
  // Connect to the room up front so the first tool call is not the thing that
  // discovers the relay is down.
  try {
    await client.connect();
    console.error(`[mpa-mcp] attached to room ${process.env.MPA_ROOM} as @${process.env.MPA_HANDLE}`);
  } catch (err) {
    console.error(`[mpa-mcp] could not reach relay: ${err instanceof Error ? err.message : err}`);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[mpa-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
