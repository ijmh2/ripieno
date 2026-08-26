# Live collaboration and shared context

Ripieno's collaboration model has five deliberately separate surfaces:

| Surface | Authority | Lifetime | Purpose |
|---|---|---|---|
| Room | relay transcript | durable, bounded | what people and agents said |
| Context | relay context store | durable, versioned, audited | what the room should remember |
| Goals | relay goal store | durable, versioned, audited | what the room intends to accomplish |
| Work | relay action log | durable, bounded | what agents actually completed |
| Presence | authenticated agent connection | ephemeral | what an agent is observably doing now |

This separation is a product and security boundary. Presence is not evidence that
work completed, and shared context is not a hidden system prompt.

## Product surfaces

### Room tabs

The compact sidebar has three tabs:

- **Room** — conversation, goals, handoffs, approvals and completed work.
- **Context** — accepted shared memory and attributed agent proposals.
- **Agents** — one inspector per attached agent, grouped implicitly by owner.

The agent inspector shows owner, capability, current observable phase, safe
summary and an optional shared-workspace file location. It never shows hidden
reasoning, raw prompts, raw terminal output, credentials or provider session
state.

### Shared context

Context is a collection of structured items rather than one concurrently edited
Markdown blob. Each item has a kind, title, body, tags, lifecycle status,
server-minted identity, author, optional exact agent author, version and audit
history.

People create accepted items. Agents create proposals. A person must accept a
proposal before it becomes canonical room memory. Items are superseded or
archived rather than silently deleted. Updates use optimistic versions, and
retry IDs make mutations idempotent across reconnects.

Accepted and proposed live context is injected into every extension-hosted agent
turn under a fixed character budget. The prompt labels it as participant-authored
reference material, with proposals explicitly unverified. Agents with Ripieno
MCP tools can use `context_read` and `context_add` to inspect the full set or add
an attributed proposal.

## Delivery plan

### Phase 1 — collaboration foundation (implemented)

- Relay-authoritative shared context types and wire messages.
- Durable persistence, cardinality and field bounds.
- Actor-derived human and exact-agent provenance.
- Optimistic item versions and monotonic context revision.
- Idempotent mutation receipts and bounded audit history.
- Proposed/accepted/superseded/archived lifecycle.
- Secret-pattern redaction before context becomes shared state.
- Context tab with creation, acceptance and retirement controls.
- Agent inspector tab with capability and ephemeral activity.
- `context_read` and `context_add` for the standalone room MCP server and the
  extension-hosted Claude MCP bridge.
- Bounded automatic context injection for all extension-hosted runners.

### Phase 2 — provider-grade live activity

Replace the runner's final-string-only contract with a structured event stream:

```ts
type RunnerEvent =
  | { type: "phase"; phase: "thinking" | "reading" | "editing" | "running" | "responding" }
  | { type: "location"; path: string; line?: number; endLine?: number }
  | { type: "draft"; delta: string }
  | { type: "tool"; name: string; safeSummary: string }
  | { type: "complete"; text: string; usage?: TurnUsage };
```

Implement native adapters for Claude Code stream JSON, Codex JSONL, Gemini CLI
events and OpenAI-compatible streaming/tool calls. Custom CLIs keep coarse
`thinking` presence unless their configuration declares a parser. Presence
updates are coalesced to at most four per second, capped, sequenced and expired
after a heartbeat timeout.

This phase also gives every built-in provider a structured `context_add` path.
Until then, all providers inspect injected context, while direct context tools
are available to MCP-attached agents and the extension-hosted Claude path.

### Phase 3 — live response drafts

- Stream user-facing response drafts into an ephemeral bubble keyed by agent.
- Reconcile the draft with one final authoritative transcript entry.
- Cancel incomplete drafts on error, detach or authority revocation.
- Never stream hidden reasoning or provider diagnostic channels.
- Apply per-agent and per-room byte/rate limits at the relay.

### Phase 4 — full Room editor panel

Keep the sidebar tabs for quick awareness and add a full editor-sized Room panel:

- Room overview plus a scrollable agent tab rail.
- One detailed tab per agent, labelled with its owner.
- Current task, goal/handoff, working set, recent actions, usage and permissions.
- Follow-agent mode and status filters.
- Owner-only diagnostics stay local and are visually separated from shared data.

### Phase 5 — shared-workspace presence

- Publish exact file and line/range only for the single shared workspace, or
  after explicit owner opt-in for a private workspace.
- Render member-coloured VS Code decorations in open shared-workspace editors.
- Clicking an inspector location opens the remote read-only document.
- Clear decorations on idle, disconnect, stale heartbeat or file invalidation.

Agents generally apply patches atomically rather than type character by
character. The UI therefore shows a truthful active range or working set, not a
fabricated keystroke cursor. In independent repository copies, paths may be
shown but exact cross-machine line alignment is not claimed.

### Phase 6 — live proposed diffs

- Stream a bounded proposed patch when a provider exposes one.
- Show it as a temporary diff owned by the exact agent.
- Reconcile it with the approved write and completed Work entry.
- Never apply a streamed proposal; the existing workspace approval boundary
  remains authoritative.

### Phase 7 — collaboration controls

- Per-agent activity sharing: summary only, shared-workspace location, or off.
- Room-owner policy for whether viewers see detailed presence.
- Follow, pause, detach and request-status controls with relay-derived authority.
- Context search, kind/tag filters, references between context, goals and work.
- Owner-controlled room rules stored separately from participant-authored
  context so persistent prompt injection cannot impersonate trusted policy.

## Non-negotiable invariants

- The socket chooses identity; payloads never choose who an activity or context
  mutation is attributed to.
- Presence is ephemeral and never restored from disk.
- Completed Work remains the evidence that an operation happened.
- Agent context starts proposed and is visibly unverified.
- Status acceptance cannot be combined with an unseen text edit.
- Hidden reasoning, secrets, raw logs and provider sessions are never shared.
- Exact editor locations are claimed only where Ripieno can map them honestly.
- All durable collections and all wire fields remain explicitly bounded.

## Verification

Each phase needs protocol typing tests, raw WebSocket authorization tests, relay
state-machine tests, persistence/restart tests, webview boundary validation,
accessibility assertions and end-to-end tests with a real runner. Presence tests
must also cover rate limiting, stale expiry, detach/revocation and draft
reconciliation.
