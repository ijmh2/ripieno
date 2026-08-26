# Phase 3 handoff — live response drafts

Written for the Phase 4 implementer. Read
[`live-collaboration-plan.md`](./live-collaboration-plan.md) and
[`phase-2-handoff.md`](./phase-2-handoff.md) first.

## State when this was written

Phase 3 is implemented by the commit containing this document on
`codex/yc-multiplayer`; its parent is `511f4e5`. Do not infer that the commit
has been pushed from this document.

Targeted verification completed while implementing:

| Check | Result |
|---|---|
| Protocol suite | 23/23 pass |
| Relay draft state machine | 11/11 pass |
| Raw WebSocket draft authorization | 3/3 pass |
| Relay full suite | 272/272 pass |
| Provider adapters, send pacing and UI assertions | 29/29 pass |
| OpenAI-compatible runner | 15/15 pass |
| AgentHost draft reconciliation and provider-error paths | 2/2 focused pass |
| Extension full suite | 259/259 pass |
| `npm test` | 652/652 pass across all workspaces |
| `npm run typecheck` | exit 0 across all seven workspaces |

Run both again after any follow-up edit; these results describe this handoff's
working tree, not a future commit.

## The contract

An agent sends:

```ts
{ t: "agentDraft", delta: string, sequence: number }
```

There is no agent id, owner, label or entry id on that frame. `server.ts` uses
the authenticated agent connection, and `Room` mints one preview id for the
active turn. Broadcast `agentDelta` frames carry the derived provenance for new
clients while retaining the original `entryId` and `text` fields for old ones.

The exact agent's next non-empty `say` consumes that active preview id. The
final `EntryMsg` therefore replaces the same DOM row and creates exactly one
durable transcript entry. An old agent that never sends drafts follows the old
path and receives a fresh final UUID as before.

Joined snapshots include the accumulated text already published for active
drafts. Relay-held coalescing tails stay out of the snapshot and arrive once as
later deltas, so a join cannot duplicate text. Drafts are current live state
only: `Room.snapshot()` and every room store omit them, so restart restores no
partial text.

## Safety and limits

Provider adapters are the first boundary:

- Claude emits drafts only from documented `stream_event` /
  `content_block_delta` / `text_delta` frames enabled with
  `--include-partial-messages`.
- OpenAI-compatible providers emit only `choices[0].delta.content`.
- Thinking/signature deltas, diagnostics, tool arguments, terminal streams and
  provider error bodies never become drafts.
- Codex and Gemini emit no drafts. Their event formats are still unverified on
  real installed binaries, as documented in the Phase 2 handoff.

`DraftStream` then coalesces provider token fragments and splits only at whole
UTF-8 code points. The relay re-enforces all limits using `Buffer.byteLength`:

| Limit | Value |
|---|---:|
| One delta | 4,096 UTF-8 bytes |
| One active agent preview | 32,000 UTF-8 bytes |
| All active room previews | 128,000 UTF-8 bytes |
| Agent input rate | 20 frames/second |
| Room input rate | 80 frames/second |
| Relay publication interval | 100 ms |
| Inactivity expiry | 45 seconds |

A sequence must be a positive safe integer advancing on the same connection.
A rate or byte violation cancels an existing preview rather than leaving a
plausible-looking bubble with silently missing text. Coalesced relay output is
also split at whole UTF-8 code points so every broadcast frame stays within the
same 4,096-byte cap.

## Cancellation and reconciliation

`Room.cancelAgentDraft` is called for:

- explicit host cancellation and an empty final reply;
- provider error or interrupted/incomplete turn;
- agent disconnect/detach;
- replacement by a socket claiming the same exact agent id;
- member demotion to viewer, cancelled before any slow handoff persistence;
- source authority release after a durable handoff claim;
- stale presence heartbeat;
- draft inactivity expiry; and
- room disposal (timer/accounting cleanup, without a pointless broadcast).

Final text is always authoritative and replaces the preview whole. It may differ
because host post-processing removes a `ripieno-context` directive, trims text,
or because a coalesced tail is overtaken by the final entry. The UI must never
append a final string to a partial one or compare them for equality.

## Files added or materially changed

```text
packages/protocol/src/index.ts
packages/protocol/test/drafts.test.ts
packages/relay/src/room.ts
packages/relay/src/server.ts
packages/relay/test/drafts.test.ts
packages/relay/test/draftWire.test.ts
packages/relay/test/handoffs.test.ts
packages/extension/src/draftStream.ts
packages/extension/src/providerEvents.ts
packages/extension/src/runners.ts
packages/extension/src/agentHost.ts
packages/extension/src/roomView.ts
packages/extension/src/extension.ts
packages/extension/media/main.js
packages/extension/media/main.css
packages/extension/test/draftStream.test.js
packages/extension/test/providerEvents.test.js
packages/extension/test/openaiCompat.test.js
packages/extension/test/agentHost.test.js
packages/extension/test/roomUi.test.js
```

## Known gaps and next work

- The Claude partial-message mapping follows the documented Messages API shape
  and the CLI flag was verified present during Phase 2, but this environment has
  no new real partial-message capture. Add one before claiming capture-backed
  coverage.
- OpenAI-compatible end-to-end coverage uses a real local HTTP/SSE exchange,
  not every vendor named by the preset list. A provider that rejects streaming
  keeps the existing non-streaming fallback and simply has no live draft.
- Codex and Gemini drafts remain disabled until their JSON modes and visible
  response channels are verified against installed binaries.
- Draft finalization is correlated by one active draft per exact agent and
  ordered `say`; the legacy `say` protocol has no client turn id. A buggy host
  that sends the final `say` twice can still create two transcript entries, as
  it could before Phase 3. Adding durable/idempotent turn submission would be a
  separate wire change, not something to smuggle into the ephemeral channel.
- Phase 4 is the full editor-sized Room panel and per-agent tab rail. Reuse the
  exact `agentId` already present on draft bubbles; do not expose provider
  reasoning or repurpose ephemeral drafts as owner-only diagnostics.
