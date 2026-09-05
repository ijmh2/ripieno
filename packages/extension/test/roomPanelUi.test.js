const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const script = fs.readFileSync(path.join(__dirname, "../media/roomPanel.js"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "../media/roomPanel.css"), "utf8");
const sidebarStyles = fs.readFileSync(path.join(__dirname, "../media/main.css"), "utf8");
const roomView = fs.readFileSync(path.join(__dirname, "../src/roomView.ts"), "utf8");
const extension = fs.readFileSync(path.join(__dirname, "../src/extension.ts"), "utf8");
const proposalDocuments = fs.readFileSync(path.join(__dirname, "../src/liveProposalDocuments.ts"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));

test("full Room panel is discoverable and keeps the compact sidebar surfaces", () => {
  assert.ok(manifest.contributes.commands.some((entry) => entry.command === "ripieno.openRoomPanel"));
  assert.match(extension, /registerCommand\("ripieno\.openRoomPanel", \(\) => roomView\.openRoomPanel\(\)\)/);
  assert.match(roomView, /createWebviewPanel\(\s*"ripieno\.roomPanel"/);
  assert.match(roomView, /role="tablist" aria-label="Ripieno room surfaces"/);
  assert.match(roomView, /role="tablist" aria-label="Room agents"/);
  assert.match(roomView, /id="agentDetail"[^>]*role="tabpanel"/);
  assert.match(roomView, /id="workspaceState"[^>]*role="status"/);
  assert.match(script, /snapshot\.workspace\.state/);
  assert.match(script, /snapshot\.workspace\.detail/);
  assert.match(styles, /\.workspace-state\.saved-local/);
});

test("agent rail, status filters and follow mode are keyboard and screen-reader accessible", () => {
  assert.match(script, /tab\.setAttribute\("role", "tab"\)/);
  assert.match(script, /tab\.setAttribute\("aria-selected", String\(selected\)\)/);
  assert.match(script, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(script, /follow\.setAttribute\("aria-pressed"/);
  assert.match(script, /Keep this exact agent selected/);
  assert.match(script, /enabledFilters\.has\(agent\.statusGroup\)/);
  assert.match(script, /enabledFilters\.add\(followed\.statusGroup\)/);
  assert.match(script, /enabled to keep following this agent/);
  assert.match(script, /focusedAgentId/);
  assert.match(script, /previousScrollLeft/);
  assert.match(script, /focus\(\{ preventScroll: !focusSelected \}\)/);
  assert.match(roomView, /aria-label="Filter agents by status"/);
  assert.doesNotMatch(roomView, /id="agentDetail"[^>]*aria-live/);
  assert.match(roomView, /id="panelAnnouncements"[^>]*aria-live="polite"/);
  assert.match(styles, /\.agent-tab-rail\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(styles, /\.agent-tab:focus-visible/);
});

test("member colour identity uses the same hue map as the sidebar", () => {
  for (let index = 0; index < 8; index += 1) {
    const pattern = new RegExp(`--ripieno-hue-${index}:\\s*([^;]+);`);
    assert.equal(styles.match(pattern)?.[1]?.trim(), sidebarStyles.match(pattern)?.[1]?.trim());
  }
  assert.match(styles, /hsl\(var\(--owner-color\) 70% 50%\)/);
});

test("detail tabs show owner, task, goals, handoffs, working set, actions, usage and scoped permissions", () => {
  for (const label of [
    "Current task",
    "Goals and handoffs",
    "Working set",
    "Recent actions",
    "Usage",
    "Capability and permissions",
  ]) assert.match(script, new RegExp(label));
  assert.match(script, /`Owner: \$\{agent\.ownerName\}`/);
  assert.match(script, /exact-agent-id/);
  assert.match(script, /agent\.recentActions/);
  assert.match(script, /agent\.privateLocal/);
  assert.match(script, /Private to this editor/);
  assert.match(script, /Provider reasoning, diagnostics, raw logs, tool JSON and credentials are not included/);
  assert.doesNotMatch(script, /innerHTML/);
});

test("exact locations are opened by authoritative agent id, never by a webview-supplied path", () => {
  assert.match(script, /type: "openAgentLocation", agentId: agent\.agentId/);
  assert.match(script, /agent\.locationOpenable/);
  assert.match(roomView, /type === "openAgentLocation"/);
  assert.match(extension, /latestRoster\.find\(\(entry\) => entry\.agents\?\.some/);
  assert.doesNotMatch(script, /openAgentLocation"[^\n]*path/);
  assert.match(styles, /\.location-link/);
});

test("temporary proposed diffs are accessible, read-only, and opened by exact agent id", () => {
  assert.match(script, /Proposed change · not applied/);
  assert.match(script, /aria-label.*Temporary proposed diff/);
  assert.match(script, /type: "openAgentProposal", agentId: agent\.agentId/);
  assert.match(script, /Review this proposal before approving a write/);
  assert.doesNotMatch(script, /openAgentProposal"[^\n]*(?:path|patch)/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(roomView, /type === "openAgentProposal"/);
  assert.match(extension, /latestProposals\.get\(agentId\)/);
  assert.match(extension, /sharedWorkspaceUriFor\(proposal\.path\)/);
  assert.match(proposalDocuments, /registerTextDocumentContentProvider/);
  // Check mutation calls; a comment naming the forbidden API is harmless.
  assert.doesNotMatch(proposalDocuments, /\b(?:applyEdit|writeFile)\s*\(|new\s+(?:vscode\.)?WorkspaceEdit\b/);
  assert.match(styles, /\.proposal-patch:focus-visible/);
});
