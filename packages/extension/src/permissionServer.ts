#!/usr/bin/env node
// A permission-prompt tool for a headless room agent.
//
// `claude -p` cannot ask a human anything: a permission request has nobody to
// answer it, so anything needing approval strands rather than being decided.
// That is why a room agent could write files freely (auto-approved) but never
// run what it wrote.
//
// This is a tiny MCP server that Claude Code calls whenever it wants
// permission. It forwards the request to the extension host over a loopback
// socket, the extension shows the member a modal, and the verdict comes back
// here. The result: full capability with a human actually in the loop, instead
// of capability decided in advance by a flag.
//
// Bundled as its own entry point (see esbuild.js) because Claude Code spawns it
// as a separate process.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import WebSocket = require("ws");

const URL = process.env.RIPIENO_APPROVAL_URL;
const TOKEN = process.env.RIPIENO_APPROVAL_TOKEN;
const AGENT_ID = process.env.RIPIENO_AGENT_ID ?? "agent";
const AGENT_LABEL = process.env.RIPIENO_AGENT_LABEL ?? "your agent";

/** Nothing may run unattended just because the bridge is unreachable. */
const CONNECT_TIMEOUT_MS = 5000;
const DECISION_TIMEOUT_MS = 300_000;

interface Pending {
  resolve: (verdict: Verdict) => void;
  timer: NodeJS.Timeout;
}

interface Verdict {
  allow: boolean;
  message?: string;
}

const pending = new Map<string, Pending>();
let socket: WebSocket | undefined;
let nextId = 0;

function connect(): Promise<WebSocket> {
  if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    if (!URL || !TOKEN) return reject(new Error("approval bridge not configured"));
    const ws = new WebSocket(URL, { headers: { "x-ripieno-token": TOKEN } });
    const timer = setTimeout(() => reject(new Error("approval bridge unreachable")), CONNECT_TIMEOUT_MS);

    ws.on("open", () => {
      clearTimeout(timer);
      socket = ws;
      resolve(ws);
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("close", () => {
      socket = undefined;
      // Fail closed: an unanswerable request is a denial, never an allowance.
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.resolve({ allow: false, message: "The approval bridge closed before a decision was made." });
      }
      pending.clear();
    });
    ws.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(String(raw)) as { id: string; allow: boolean; message?: string };
        const entry = pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve({ allow: msg.allow, message: msg.message });
      } catch {
        // Ignore malformed frames rather than crashing the agent's tool call.
      }
    });
  });
}

async function ask(toolName: string, input: unknown): Promise<Verdict> {
  const ws = await connect();
  const id = `req_${nextId++}`;
  return new Promise<Verdict>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ allow: false, message: `No decision within ${DECISION_TIMEOUT_MS / 1000}s — treated as declined.` });
    }, DECISION_TIMEOUT_MS);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify({ id, agentId: AGENT_ID, agentLabel: AGENT_LABEL, toolName, input }));
  });
}

const server = new McpServer({ name: "mpa-approvals", version: "0.0.1" });

server.registerTool(
  "approve",
  {
    title: "Ask the member for permission",
    description:
      "Ask this agent's owner to approve a tool call. Called automatically by Claude Code; not for direct use.",
    inputSchema: {
      tool_name: z.string().describe("The tool wanting to run."),
      input: z.unknown().describe("The tool's input."),
    },
  },
  async ({ tool_name, input }) => {
    let verdict: Verdict;
    try {
      verdict = await ask(tool_name, input);
    } catch (err) {
      verdict = {
        allow: false,
        message: `Could not reach the approval bridge: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // The documented contract for a permission-prompt tool: a single text block
    // holding JSON with `behavior` allow|deny.
    const payload = verdict.allow
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: verdict.message ?? "The member declined." };

    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error(`[mpa-approvals] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
