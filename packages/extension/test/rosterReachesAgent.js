// Stands in for a coding-agent CLI. Records the prompt it was given and prints
// a reply, so a test can assert what the agent was actually told rather than
// what we believe it was told.
//
// MPA_TEST_REPLIES is a JSON list of {when, reply}: the first entry whose `when`
// appears in the prompt is used. That is enough to script one agent naming
// another, which is the only way to see a chain actually run.
const fs = require("node:fs");

const prompt = process.argv[2] ?? "";
fs.appendFileSync(process.env.MPA_TEST_RECORD, `${JSON.stringify(prompt)}\n`);

const replies = JSON.parse(process.env.MPA_TEST_REPLIES ?? "[]");
const match = replies.find((r) => prompt.includes(r.when));
process.stdout.write(match ? match.reply : "noted");
