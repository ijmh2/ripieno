const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../media/main.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../media/main.css"), "utf8");
const extensionHost = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const roomViewHost = fs.readFileSync(path.join(__dirname, "../src/roomView.ts"), "utf8");

test("only the signed-in member's human messages use the outgoing side", () => {
  assert.match(
    script,
    /kind === "human" && currentUser\?\.handle === authorHandle/,
    "ownership must use the relay-authenticated handle, not a display-name comparison"
  );
  assert.match(script, /container\.classList\.add\("mine"\)/);
  assert.match(styles, /\.row\.human\.mine\s*\{[^}]*align-items:\s*flex-end/s);
  assert.match(styles, /\.row\.human\.mine \.bubble\s*\{[^}]*align-self:\s*flex-end/s);
  assert.match(styles, /\.row\.human\.mine \.bubble\s*\{[^}]*border-right:\s*3px/s);
});

test("the composer offers every implemented room command", () => {
  for (const command of ["/help", "/agents", "/model", "/attach", "/detach", "/goal", "/context", "/handoff"]) {
    assert.match(script, new RegExp(`insert: "${command.replace("/", "\\/")}"`));
  }
  assert.match(script, /\/model.*Choose an agent and provider model/);
});

test("shared context and agent inspectors are separate accessible room surfaces", () => {
  assert.match(roomViewHost, /role="tablist" aria-label="Ripieno room surfaces"/);
  assert.match(roomViewHost, /id="contextPanel"[^>]*role="tabpanel"/);
  assert.match(roomViewHost, /id="agentsPanel"[^>]*role="tabpanel"/);
  assert.match(roomViewHost, /Durable, attributed memory/);
  assert.match(script, /type: "contextCreate"/);
  assert.match(script, /type: "contextStatus"/);
  assert.match(roomViewHost, /Agent additions remain proposed/);
  assert.match(script, /agent\.activity/);
  // A range, when there is one: agents patch regions rather than typing, so a
  // single line would be a less honest claim than the one the relay sends.
  assert.match(script, /presence\.endLine > presence\.line/);
  // The phase is never carried by the coloured dot alone: the dot is decorative
  // and the inspector's accessible name states what the agent is doing.
  assert.match(script, /dot\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(
    script,
    /aria-label",\s*`\$\{agent\.label\}, owned by \$\{member\.displayName \|\| member\.handle\}, \$\{activityText\.textContent\}`/
  );
  assert.match(roomViewHost, /Hidden reasoning and raw logs are never shared/);
  assert.match(styles, /\.surface-tabs\s*\{/);
  assert.match(styles, /\.context-card\.proposed/);
  assert.match(styles, /\.agent-inspector\s*\{/);
});

test("live response drafts are attributed, accessible and replaced wholesale by final transcript", () => {
  assert.match(script, /row\.container\.dataset\.agentId = draft\.agentId/);
  assert.match(script, /is drafting a reply/);
  assert.match(script, /setAttribute\("aria-busy", "true"\)/);
  assert.match(script, /caret\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(styles, /\.row\.agent\.live-draft \.bubble\s*\{[^}]*border-style:\s*dashed/s);
  assert.match(styles, /content:\s*" · drafting"/);

  // A joined snapshot carries the accumulated string once; subsequent frames
  // append to its object rather than creating another author row.
  assert.match(script, /liveDeltaText\.set\(draft\.entryId, draft\)/);
  assert.match(script, /text:\s*`\$\{previous\?\.text \?\? ""\}\$\{message\.text\}`/);
  assert.match(script, /const existing = rowEls\.get\(entryId\)/);

  // Final text may differ after host post-processing (for example a stripped
  // ripieno-context directive), so reconciliation replaces the whole preview.
  assert.match(script, /existing\.container\.replaceWith\(row\.container\)/);
  assert.match(script, /liveDeltaText\.delete\(entry\.id\)/);
});

test("invite onboarding is a compact accessible fixed three-step flow", () => {
  assert.match(roomViewHost, /id="onboardingSteps"[^>]*aria-label="Getting started progress"/);
  assert.match(script, /next\.steps\.length !== 3/);
  assert.match(script, /item\.setAttribute\("aria-current", "step"\)/);
  assert.match(
    script,
    /action !== "startSolo" &&\s*action !== "joinRoom" &&\s*action !== "addAgent" &&\s*action !== "attachAgent"/
  );
  assert.match(script, /type: "onboardingAction", action/);
  assert.match(styles, /\.onboarding-steps\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
  assert.match(styles, /@media \(max-width: 260px\)/);
  assert.match(styles, /@media \(max-width: 260px\)[\s\S]*\.onboarding-steps\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(styles, /\.onboarding-action:focus-visible/);
  assert.match(roomViewHost, /A ChatGPT web conversation cannot be imported/);
  assert.match(roomViewHost, /API-key usage is billed separately through the OpenAI Platform/);
});

test("agent creation uses fast defaults and moves optional choices to Customize", () => {
  const start = extensionHost.indexOf("async function addAgent");
  const end = extensionHost.indexOf("type AgentSetting", start);
  const addAgent = extensionHost.slice(start, end);
  assert.match(addAgent, /nextAgentLabel/);
  assert.match(addAgent, /model = provider\.suggestedModel/);
  assert.match(addAgent, /safestUsablePermission/);
  assert.match(addAgent, /responseModeForNewAgent/);
  assert.doesNotMatch(addAgent, /title: `Model for/);
  assert.doesNotMatch(addAgent, /brief:\s*await/);
  assert.match(addAgent, /Agent added/);
  assert.match(addAgent, /showInformationMessage\(status, "Customize"\)/);
  assert.match(extensionHost, /\$\(comment-discussion\) Response mode/);
  assert.match(extensionHost, /\$\(lock\) Read project/);
  assert.match(extensionHost, /\$\(shield\) Trusted workspace/);
  assert.match(extensionHost, /\$\(shield\) Ask before changes/);
});

test("handoffs show explicit tasks and lifecycle consent without an arbitrary command bridge", () => {
  assert.match(script, /className = "handoff-card"/);
  assert.match(script, /setAttribute\("role", "listitem"\)/);
  assert.match(script, /Accept and run/);
  assert.match(script, /does not move the source provider session/);
  assert.match(script, /type: "handoffAction"/);
  assert.match(script, /expectedVersion: handoff\.version/);
  assert.match(script, /task\.textContent = handoff\.task/);
  assert.match(script, /title\.id = `\$\{accessibleId\}-title`/);
  assert.match(script, /meta\.id = `\$\{accessibleId\}-status`/);
  assert.match(script, /task\.id = `\$\{accessibleId\}-task`/);
  assert.match(script, /card\.setAttribute\("aria-labelledby", `\$\{title\.id\} \$\{meta\.id\}`\)/);
  assert.match(script, /\[task\.id, lifecycleId, note\.id\]\.filter\(Boolean\)\.join\(" "\)/);
  assert.doesNotMatch(script, /task\.setAttribute\("aria-label", "Handoff task"\)/);
  assert.doesNotMatch(script, /card\.setAttribute\(\s*"aria-label"/);
  assert.match(script, /outcomeUnknown/);
  assert.match(script, /Retry manually/);
  assert.doesNotMatch(script, /handoffAction[\s\S]{0,300}command:/);
  assert.match(extensionHost, /case "handoff"/);
  assert.match(extensionHost, /if \(handleRoomCommand\(text\)\) return/);
  assert.match(styles, /\.handoff-button:focus-visible/);
  assert.match(styles, /\.handoff-button:disabled/);
});

test("durable goals have a compact accessible authoritative view", () => {
  assert.match(script, /goal-row/);
  assert.match(script, /setAttribute\("role", "listitem"\)/);
  assert.match(script, /msg\.roomRevision >= roomRevision/);
  assert.match(script, /No goals yet — use \/goal create <text>/);
  assert.match(script, /goal-provenance/);
  assert.match(script, /goalAnnouncementsEl\.textContent/);
  assert.match(script, /msg\.roomRevision > roomRevision/);
  assert.match(script, /retire the oldest completed goal first/);
  assert.match(extensionHost, /pendingGoalMutations\.forRoom\(msg\.room\)/);
  assert.match(extensionHost, /pendingGoalMutations\.acknowledge\(msg\.requestId\)/);
  assert.match(styles, /\.goal-row\.completed[\s\S]*text-decoration:\s*line-through/);
  assert.match(styles, /\.sr-only/);
});
