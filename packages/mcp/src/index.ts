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
import type { TranscriptEntry } from "@ripieno/protocol";
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
  url: process.env.RIPIENO_RELAY_URL ?? "ws://localhost:8787",
  room: required("RIPIENO_ROOM"),
  handle: required("RIPIENO_HANDLE"),
  displayName: process.env.RIPIENO_NAME ?? required("RIPIENO_HANDLE"),
  repo: process.env.RIPIENO_REPO,
  token: process.env.RIPIENO_TOKEN,
  // Needed only by a relay running RIPIENO_REQUIRE_GITHUB=1; harmless otherwise.
  githubToken: process.env.RIPIENO_GITHUB_TOKEN,
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

const server = new McpServer({ name: "ripieno-room", version: "0.0.1" });

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
              const hosting = client.workspaceHost() === r.handle ? ", HOSTS the shared workspace" : "";
              return `- ${r.displayName} (@${r.handle}) — ${state}${hosting}${agents}${repo}`;
            })
            .join("\n");
    return { content: [{ type: "text", text }] };
  }
);

/* ------------------------------------------------------------------ */
/* The shared workspace                                                */
/* ------------------------------------------------------------------ */

/**
 * Tools that act on somebody else's machine.
 *
 * This agent cannot touch another member's disk directly — nor should it. The
 * request travels to that member's editor, which executes it under their
 * permissions and asks them to approve it. The result comes back here, and the
 * room records what was done and by whom.
 */
const TARGET_DESCRIPTION =
  'Whose workspace to act on: a member handle, or "room" for whoever is hosting the shared workspace. Defaults to "room".';

function target(member: unknown): string {
  return typeof member === "string" && member.trim() !== "" ? member.trim().replace(/^@/, "") : "room";
}

async function remote(
  member: unknown,
  name: string,
  input: Record<string, unknown>
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  await client.connect();
  const result = await client.remoteTool(target(member), name, input);
  return { content: [{ type: "text", text: result.content }], isError: result.isError };
}

server.registerTool(
  "workspace_read_file",
  {
    title: "Read a file from the shared workspace",
    description:
      "Read a file on another member's machine. Use this rather than guessing at contents you cannot see — " +
      "you and they do not share a filesystem.",
    inputSchema: {
      path: z.string().describe("Workspace-relative path."),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
      offset: z.number().int().optional().describe("First line, 1-based."),
      limit: z.number().int().optional().describe("How many lines to return."),
    },
  },
  ({ path, member, offset, limit }) => remote(member, "read_file", { path, offset, limit })
);

server.registerTool(
  "workspace_list_files",
  {
    title: "List files in the shared workspace",
    description: "List files on another member's machine, to orient yourself before reading.",
    inputSchema: {
      dir: z.string().optional().describe("Workspace-relative directory."),
      glob: z.string().optional().describe('Filter, e.g. "**/*.ts".'),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
    },
  },
  ({ dir, glob, member }) => remote(member, "list_files", { dir, glob })
);

server.registerTool(
  "workspace_search",
  {
    title: "Search the shared workspace",
    description: "Text-search another member's workspace when you do not know which file to read.",
    inputSchema: {
      query: z.string().describe("Literal text to find."),
      glob: z.string().optional(),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
    },
  },
  ({ query, glob, member }) => remote(member, "search", { query, glob })
);

server.registerTool(
  "workspace_write_file",
  {
    title: "Write a file in the shared workspace",
    description:
      "Create or overwrite a file on another member's machine. They are shown a diff and must approve it, " +
      "so send the complete intended contents and expect a wait.",
    inputSchema: {
      path: z.string(),
      content: z.string().describe("The complete file contents."),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
    },
  },
  ({ path, content, member }) => remote(member, "write_file", { path, content })
);

server.registerTool(
  "workspace_edit_file",
  {
    title: "Edit a file in the shared workspace",
    description:
      "Replace an exact string in a file on another member's machine. old_text must match exactly once. " +
      "They review a diff before anything is applied.",
    inputSchema: {
      path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
    },
  },
  ({ path, old_text, new_text, member }) =>
    remote(member, "edit_file", { path, old_text, new_text })
);

server.registerTool(
  "workspace_run_command",
  {
    title: "Run a command in the shared workspace",
    description:
      "Run a shell command on another member's machine. They approve it unless they have allowlisted it, " +
      "so prefer the narrowest command that answers the question.",
    inputSchema: {
      command: z.string(),
      member: z.string().optional().describe(TARGET_DESCRIPTION),
    },
  },
  ({ command, member }) => remote(member, "run_command", { command })
);

server.registerTool(
  "room_actions",
  {
    title: "What agents have already done",
    description:
      "The room's record of work: which agent read, wrote or ran what, on whose machine, and whether it " +
      "succeeded. Check this before repeating something — another agent may have already run the tests or " +
      "made the change you are about to make. It is also how you find out what changed under you.",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("How many recent actions. Defaults to 30."),
    },
  },
  async ({ limit }) => {
    await client.connect();
    const actions = client.currentActions().slice(-(limit ?? 30));
    if (actions.length === 0) {
      return { content: [{ type: "text", text: "No agent has done any work in this room yet." }] };
    }
    const text = actions
      .map((a) => {
        const when = new Date(a.ts).toISOString().slice(11, 19);
        const detail = a.detail ? ` — ${a.detail}` : "";
        return `[${when}] ${a.agentLabel} ${a.verb} ${a.target} on @${a.targetHandle}${detail}${a.ok ? "" : " (failed)"}`;
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
    console.error(`[mpa-mcp] attached to room ${process.env.RIPIENO_ROOM} as @${process.env.RIPIENO_HANDLE}`);
  } catch (err) {
    console.error(`[mpa-mcp] could not reach relay: ${err instanceof Error ? err.message : err}`);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[mpa-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
