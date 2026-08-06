#!/usr/bin/env node
/**
 * Demo harness — puts a second person and their agent in a room so the UI can
 * be seen doing its actual job without needing a second machine or account.
 *
 * Not part of the product. It connects over the ordinary WebSocket protocol,
 * exactly as a real member would.
 *
 *   node scripts/demo-member.js [room]
 */

const WebSocket = require("ws");

const URL = process.env.RIPIENO_RELAY_URL || "ws://localhost:8787";
const ROOM = process.argv[2] || process.env.RIPIENO_ROOM || "demo";
const SAM = { handle: "swhitfield", displayName: "Sam Whitfield", repo: "mellery/tgtbt" };

function connect(role, onEntry) {
  const ws = new WebSocket(URL);
  ws.on("open", () => {
    ws.send(JSON.stringify({ t: "join", room: ROOM, role, member: SAM }));
    console.log(`[demo] ${role === "agent" ? "Sam's agent" : "Sam"} joined ${ROOM}`);
  });
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === "entry") onEntry(msg.entry, ws);
  });
  ws.on("error", (e) => console.error(`[demo] ${role} error:`, e.message));
  ws.on("close", () => console.log(`[demo] ${role} disconnected`));
  return ws;
}

const say = (ws, text) => ws.send(JSON.stringify({ t: "say", text }));
const replied = new Set();

// Sam, the human: reacts to whatever the real user types.
//
// Deliberately asserts NO findings. An earlier version had Sam report a Sharpe
// ratio and cite files that do not exist; a real agent reading the room went and
// checked, found nothing, and had to spend a turn correcting the record. In a
// product built on attribution, seeding plausible fabrications into the shared
// transcript is the one thing a demo must not do.
connect("human", (entry, ws) => {
  if (entry.kind !== "human" || entry.authorHandle === SAM.handle) return;
  if (replied.has(entry.id)) return;
  replied.add(entry.id);
  setTimeout(
    () =>
      say(
        ws,
        "(scripted stand-in — I have no workspace and no findings) " +
          "Reading you fine, so the room is fanning out correctly."
      ),
    1200
  );
});

// Sam's agent: replies after Sam, so the room shows an agent message attributed
// to its owner rather than to the room. Also asserts nothing about any codebase.
connect("agent", (entry, ws) => {
  if (entry.kind !== "human" || entry.authorHandle !== SAM.handle) return;
  if (replied.has(`a:${entry.id}`)) return;
  replied.add(`a:${entry.id}`);
  setTimeout(() => {
    say(
      ws,
      "(scripted stand-in, not a model) I exist to show what an agent message looks like: " +
        "full width, neutral fill, edged in my owner's colour.\n\n" +
        "```text\nno real tool call was made to produce this\n```"
    );
  }, 2600);
});

console.log(`[demo] watching room "${ROOM}" — type in the extension panel to get a reply`);
