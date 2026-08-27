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

### Phase 2 — provider event and live-activity foundation (implemented)

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

Codex and Gemini's documented-shape adapters remain unverified against installed
binaries and their presets do not yet enable JSON output. That gap is recorded
explicitly in the Phase 2 handoff rather than being hidden by the implemented
event contract.

### Phase 3 — live response drafts (implemented)

- Claude documented `text_delta` and OpenAI-compatible assistant-content deltas
  are the only provider channels that emit drafts. Hidden reasoning, tool JSON,
  terminal output and diagnostics never do. Claude Task sub-agent frames with
  a `parent_tool_use_id` are internal work and are rejected even when they
  contain text deltas.
- An agent frame contains only a delta and monotonic sequence. The relay derives
  exact agent/owner/label from the authenticated socket and mints one active
  preview id; payloads cannot choose either identity or transcript id.
- Relay limits use UTF-8 bytes: 4,096 per frame, 32,000 per agent preview and
  128,000 across active room previews, plus 20 input frames/second per agent and
  80/second per room. Broadcasts are coalesced to 100 ms and split at whole
  UTF-8 code points so coalescing never creates an oversized output frame.
- Per-agent frame, rate and byte violations withdraw that agent's incomplete
  preview. Aggregate room rate or byte saturation sheds only the excess
  fragment and preserves an existing preview id for final reconciliation.
- Drafts expire after 45 seconds and are never persisted. A snapshot of text
  already published is included for a client joining while a draft is live;
  an unpublished coalescing tail arrives once as a later delta.
- The next final `say` from that exact agent reuses the relay-minted preview id,
  producing one authoritative transcript entry and replacing the bubble whole.
- Incomplete previews are canceled on provider error, empty result, explicit
  cancellation, detach, exact-id replacement, room-role revocation, handoff
  authority transfer, stale presence or draft expiry.
- The accessible bubble names the exact attributed agent, is marked busy and
  visibly provisional. Older agents that only send `say`, and older clients
  that understand the original two-field `agentDelta`, continue to work.

### Phase 4 — full Room editor panel (implemented)

- The compact Room, Context and Agents sidebar tabs remain the quick-awareness
  surface. **Ripieno: Open Full Room Panel** opens a separate editor-sized view.
- A relay-derived overview counts present people, exact attached agents, active
  goals, open handoffs, durable Work and live shared context. A horizontally
  scrollable, keyboard-operable tab rail labels every exact agent with its owner.
- Each tab shows the safe observable task summary, shared phase/location,
  relevant goals and handoffs, a working set built from the live location and
  exact-agent Work targets, recent durable actions, provider-reported usage,
  capability and permissions.
- Active, idle and not-reported filters and exact-agent follow mode persist only
  in that webview. Follow keeps the selected tab pinned and announces new safe
  activity; Phase 5 adds exact-location navigation and editor decorations.
- The signed-in owner's local provider, model, project, permission and response
  mode are matched only to their relay-namespaced exact agent id and rendered in
  a visibly private section. Another owner's settings are not relayed or
  inferred. Provider reasoning, diagnostics, logs, tool JSON, credentials and
  ephemeral draft text are absent from the panel model.

### Phase 5 — shared-workspace presence (implemented)

- Every exact path carries an explicit `shared` or `private` coordinate scope.
  Unscoped paths from older or custom clients degrade to coarse presence. The
  relay accepts `shared` only while one workspace host exists and clears shared
  coordinates whenever that host changes or leaves.
- Native provider locations are shared only when the reporting agent's root is
  exactly the folder this member hosts. Ripieno's exact, known bundled workspace
  MCP tools are shared because they already address the room's single remote
  tree. Paths must remain confined and workspace-relative at both sender and
  relay boundaries.
- Private workspace locations are withheld by default. The owner may enable
  `ripieno.sharePrivateWorkspacePresence`; the path then remains visibly marked
  private, and only that owner's editor maps it onto their local agent folder.
- Open documents show the reporting member's colour across the honest 1-based,
  inclusive active range. Presence with only a path remains navigable but does
  not invent a line or a keystroke caret.
- Clicking a mappable inspector location sends only the exact agent id to the
  extension host. The host re-reads authoritative presence and either opens the
  host's local file, the remote read-only `ripieno-workspace:` document, or the
  opted-in owner's local private file.
- Decorations and locally displayed exact coordinates clear on idle, detach,
  stale relay heartbeat, local disconnect, workspace-host change and file
  invalidation. A changed file stays suppressed until that exact agent reports
  a newer observation.
- A member cannot claim a workspace host lease without an open local filesystem
  folder. An empty editor offers to create a collision-safe visible folder under
  `Documents/Ripieno` or choose an existing one, attaches it, then claims. Closing
  the exact hosted folder releases the lease.
- The Room panel distinguishes **Saved locally**, **Live from @host** and
  **Workspace offline**, and explicitly reports the absence of a durable
  checkpoint. Checkpointed/GitHub-synced states must be earned by a later
  persistence feature rather than inferred from a live host.

Agents generally apply patches atomically rather than type character by
character. The UI therefore shows a truthful active range or working set, not a
fabricated keystroke cursor. Independent repository copies receive no exact
path by default, because even a matching filename cannot establish line
alignment across different commits.

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
