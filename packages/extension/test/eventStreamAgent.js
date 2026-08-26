// Stands in for a coding-agent CLI that emits structured events.
//
// It prints Codex-shaped JSONL — a shell command whose line contains a
// credential, a file change, and the reply — so a test can watch a real room
// receive presence derived from a real subprocess's stream, and check that the
// stream's own contents did not come with it.
//
// RIPIENO_EVENT_REPLY overrides the agent message, which is how a test drives
// the context directive block through the same path.
const fs = require("node:fs");

const prompt = process.argv[2] ?? "";
if (process.env.RIPIENO_TEST_RECORD) {
  fs.appendFileSync(process.env.RIPIENO_TEST_RECORD, `${JSON.stringify(prompt)}\n`);
}

const reply = process.env.RIPIENO_EVENT_REPLY ?? "Patched the runner and the test.";
const frames = [
  { type: "thread.started", thread_id: "thread_e2e" },
  {
    type: "item.completed",
    item: {
      id: "i1",
      type: "command_execution",
      command: "curl -H 'authorization: Bearer sk-live-must-not-leak' https://example.test",
      aggregated_output: "PASSWORD=hunter2",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "i2",
      type: "file_change",
      changes: [{ path: "packages/extension/src/runners.ts", kind: "update" }],
    },
  },
  { type: "item.completed", item: { id: "i3", type: "agent_message", text: reply } },
  { type: "turn.completed", usage: { input_tokens: 11, output_tokens: 22 } },
];

let at = 0;
/**
 * Emitted with gaps wider than the relay's coalescing window, so each frame is
 * actually published rather than overtaken by the next one.
 */
function next() {
  if (at >= frames.length) {
    process.exit(0);
    return;
  }
  process.stdout.write(`${JSON.stringify(frames[at++])}\n`);
  setTimeout(next, 300);
}
next();
