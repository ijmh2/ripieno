#!/usr/bin/env node
/**
 * Makes a BYO agent *reactive*.
 *
 * MCP is pull-based: the model runs only when its human prompts it, so an agent
 * attached over MCP never notices that somebody spoke. This daemon closes that
 * gap for BYO mode — it holds the room connection itself, watches for messages
 * addressed to the room, runs one Claude Code turn, and posts the answer back.
 *
 * Because the daemon owns the connection, the agent stays resident in the
 * roster instead of joining and leaving around every turn. Claude Code is
 * invoked WITHOUT the room tools: it does not need them, since the transcript
 * is handed to it and the daemon does the posting. It keeps its ordinary file
 * and shell access, so it can still check claims against the real workspace.
 *
 *   node scripts/agent-daemon.js [room] [handle] [displayName]
 */

const WebSocket = require("ws");
const { spawn } = require("node:child_process");
const path = require("node:path");

const URL = process.env.MPA_RELAY_URL || "ws://localhost:8787";
const ROOM = process.argv[2] || process.env.MPA_ROOM || "demo";
const HANDLE = process.argv[3] || process.env.MPA_HANDLE || "ijmh2";
const NAME = process.argv[4] || process.env.MPA_NAME || "Mira Ellery";
const CWD = path.resolve(__dirname, "..");

/** Wait this long for the room to settle before answering. */
const DEBOUNCE_MS = 1500;
const HISTORY = 25;

const transcript = [];
let busy = false;
let pendingTimer = null;
let ws;

function connect() {
  ws = new WebSocket(URL);
  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "join", room: ROOM, role: "agent", member: { handle: HANDLE, displayName: NAME } }));
    console.log(`[agent] ${NAME}'s agent is watching ${ROOM}`);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "joined") {
      transcript.length = 0;
      transcript.push(...msg.transcript);
      // Everything before we attached is context, not a question to answer.
      fed = transcript.length;
    } else if (msg.t === "entry") {
      transcript.push(msg.entry);
      consider(msg.entry);
    }
  });
  ws.on("close", () => {
    console.log("[agent] disconnected, retrying in 2s");
    setTimeout(connect, 2000);
  });
  ws.on("error", (e) => console.error("[agent] socket error:", e.message));
}

/**
 * React to any human message, including our owner's — an agent that ignores the
 * person it belongs to is useless.
 *
 * Agent messages are deliberately not triggers: that is what stops two agents in
 * one room from answering each other forever. The debounce lets the room settle,
 * so a burst of messages produces one considered reply rather than several.
 */
function consider(entry) {
  if (entry.kind !== "human") return;
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(respond, DEBOUNCE_MS);
}

function render() {
  return transcript
    .slice(-HISTORY)
    .filter((e) => e.kind !== "system")
    .map((e) => `${e.authorName} (@${e.authorHandle}): ${e.text}`)
    .join("\n\n");
}

/** Claude Code session this agent owns, so turns share context. */
let sessionId = null;
/** How far through the transcript the session has already been told about. */
let fed = 0;

const SYSTEM = [
  `You are ${NAME}'s agent, participating in a shared room alongside other people and their agents.`,
  `Messages arrive labelled with their author. Attribute anything you assert to whoever said it, and`,
  `never merge different people's statements into one anonymous view.`,
  ``,
  `You have full file and shell access to ${CWD}. Behave exactly as you normally would: read code before`,
  `answering about it, run commands when that is the way to find out, and say plainly when a claim in the`,
  `room is unsupported rather than repeating it.`,
  ``,
  `Your reply is posted verbatim into the room, so write the message itself — no preamble, no sign-off,`,
  `no restating the question. Length should fit the question: a sentence for a simple one, more when the`,
  `work warrants it. Several people are reading, so do not pad.`,
].join("\n");

function respond() {
  if (busy) return;

  // With a live session, only the messages it has not seen need sending; the
  // session itself remembers the rest, including whatever it read last turn.
  const unseen = transcript.slice(fed).filter((e) => e.kind !== "system");
  if (unseen.length === 0) return;
  busy = true;
  fed = transcript.length;

  const body = unseen.map((e) => `${e.authorName} (@${e.authorHandle}): ${e.text}`).join("\n\n");
  const prompt = sessionId ? body : `${SYSTEM}\n\n--- the room so far ---\n${render()}`;

  // Resume by explicit id rather than --continue: --continue would latch onto
  // whatever conversation was last used in this directory, which could be the
  // human's own interactive session.
  const args = [
    "-p",
    prompt,
    "--output-format",
    "json",
    // Suppress .mcp.json. Otherwise every turn boots the `room` MCP server,
    // which joins as a *second* agent under this same handle — the repeated
    // "joined the room" lines — and adds its startup to every reply. The daemon
    // already owns the room connection; the model does not need room tools.
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    // Headless runs cannot prompt, so without this every Write/Edit is denied
    // and the agent quietly falls back to writing somewhere useless.
    "--permission-mode",
    "acceptEdits",
  ];
  if (sessionId) args.push("--resume", sessionId);

  console.log(`[agent] thinking${sessionId ? " (resumed)" : " (new session)"}…`);
  const child = spawn("claude", args, { cwd: CWD, stdio: ["ignore", "pipe", "pipe"] });

  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => process.stderr.write(`[claude] ${d}`));
  child.on("close", (code) => {
    busy = false;
    let text = out.trim();
    try {
      const parsed = JSON.parse(text);
      if (parsed.session_id) sessionId = parsed.session_id;
      text = String(parsed.result ?? "").trim();
    } catch {
      // Not JSON — fall back to the raw output rather than losing the reply.
    }
    if (code !== 0 || !text) {
      console.error(`[agent] no reply (exit ${code})`);
      return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: "say", text }));
      console.log(`[agent] posted ${text.length} chars`);
    }
    // Anything said while we were thinking still needs an answer.
    if (transcript.length > fed) consider(transcript[transcript.length - 1]);
  });
}

connect();
