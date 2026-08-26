# Phase 2 handoff — provider-grade live activity

Written for whoever picks up Phase 3. It assumes you have read
[`live-collaboration-plan.md`](./live-collaboration-plan.md) but not that you were
here when Phase 2 was built.

## State when this was written

Branch `codex/yc-multiplayer`, rebased onto `origin/main` at `fb67012` with a
clean working tree.

```
4e78576  A label a body can rewrite is not a label          Phase 1 debt fixes
aa0ba03  Presence derived from the provider stream…         Phase 2
c5e50bc  Add live agent collaboration and shared context    Phase 1
```

+3723 / −184 across 31 files since Phase 1.

| Check | Result |
|---|---|
| `npm test` | 627 tests, 627 pass, 0 fail, 137 suites — exit 0 |
| `npm run typecheck` | exit 0, no diagnostics across all 7 workspaces |

The rebase incorporated the relay frame hardening, agent promotion and handle
identity changes that previously sat ahead on `main`. Its one conflict was in
`packages/extension/src/roomViewMessages.ts`: the resolution keeps `startSolo`
in the onboarding union as well as `contextCreate` and `contextStatus`. The full
suite above was run after that resolution rather than treating a clean rebase as
proof of clean behaviour.

## What Phase 2 built

### The event contract

`ModelRunner.run(ctx, log, onEvent?)` — the third parameter is optional, so every
pre-existing call site compiles and behaves exactly as before. `run()` still
resolves to the final text, which is what the room posts; events are additive.

```ts
type RunnerEvent =
  | { type: "phase"; phase: "thinking" | "reading" | "editing" | "running" | "responding" }
  | { type: "location"; path: string; line?: number; endLine?: number }
  | { type: "draft"; delta: string }
  | { type: "tool"; name: string; safeSummary: string }
  | { type: "complete"; text: string; usage?: TurnUsage };
```

`draft` is defined because it is part of the agreed union. **Phase 2 never emits
it.** See "Where Phase 3 picks up".

### Flow

```
runner.run(ctx, log, onEvent)
  → provider adapter turns bytes into RunnerEvent
  → AgentHost.handleRunnerEvent maps to a presence update
  → PresenceStream: coalesce 250ms, mint sequence, bound fields
  → {t:"agentActivity"} on the agent's own socket
  → server.ts supplies agentId FROM THE CONNECTION, never the payload
  → Room.setAgentActivity: validate, redact, host-gate path, check sequence, coalesce
  → broadcastRoster → webview inspector
```

### The safety boundary

A provider stream is not safe material. It carries hidden reasoning, raw terminal
output, file contents and — in a shell line or an environment dump — credentials.
Nothing from it reaches a room.

`packages/extension/src/runnerEvents.ts` is where that is enforced:

- `summariseTool` returns one of a fixed set of phrases. The only variable parts
  are a path and a tool name, both already sanitised.
- `safeToolName` keeps identifier characters and 40 of them.
- `safePath` rejects control characters, relativises absolute paths against the
  agent's own directory and **drops anything outside it** — an agent reading
  `~/.aws/config` announces nothing — and refuses `../` climbs.
- A shell command is described, never quoted.

The relay then redacts via `redactHandoffText` and caps at 240/500. **The
derivation is the boundary that matters**; a cap on a leaked secret is still a
leaked secret. If you add an adapter, add it to this file's vocabulary rather
than passing a provider string through.

### Presence is now bounded in time, not only in size

Enforced in `Room.setAgentActivity`, **relay-side** — the client mirrors it only
to avoid sending frames that would be dropped:

- Coalesced to one frame per 250 ms. Because the window is measured in *time*, a
  host that mints a huge sequence buys ordering and nothing else.
- A `sequence` must be a positive safe integer advancing past
  `max(accepted, pending)`, or the frame is dropped.
- Presence expires after 45 s, swept every 5 s. `agentsOf` hides `activity` **and**
  `state` past the TTL — falling back to a confident phase from minutes ago is the
  same lie in a quieter voice.
- An identical repeat is treated as a heartbeat: refresh the timestamp, spend no
  broadcast.
- `setAgentState` delegates here, so coarse state cannot bypass the limit.

Timers are cleared on leave, role revocation, handoff source release, agent-id
replacement and `dispose()`, and all are `unref()`ed.

## Phase 1 debt fixed here

Three defects from the Phase 1 review, in `4e78576`:

- **Context prompt injection.** `sharedContext()` spliced raw participant text
  into every agent's prompt under a plain `--- shared room context ---` line,
  while `formatHandoffContinuation` four lines below it in the same file quoted
  every field. Now `formatSharedContext()` (exported, so it is testable) renders
  quoted `field=value` pairs inside a `[BEGIN/END RELAY-AUTHORITATIVE SHARED ROOM
  CONTEXT]` envelope, and `quotedForPrompt()` is shared by both paths instead of
  living as a local const inside one of them. Proposed entries are still
  injected — an agent's note is useful before ratification — but the mark saying
  so is now one a body cannot forge.
- **Undefined bridge input.** `serveWorkspaceCall` threw inside a voided async
  handler when a frame omitted `input`, so the caller waited out its own timeout.
  The frame is now checked for the shape it claims to have.
- **Audit erased on reclaim.** `reclaimOldestTerminalContext` deleted the retired
  item's audit entries and idempotency receipts along with it. Now it drops only
  the item. The audit is separately bounded; the receipts stay because dropping
  them let a retry of the original create mint a duplicate.

## Folder structure

```
packages/
  protocol/
    src/index.ts                      M   endLine/sequence, MAX_PRESENCE_*
    test/presence.test.ts             NEW protocol typing
  relay/
    src/room.ts                       M   coalescing, sequencing, expiry, sweep, reclaim
    src/server.ts                     M   forwards endLine + sequence
    test/presence.test.ts             NEW relay state machine
    test/presenceWire.test.ts         NEW raw WebSocket authorization
    test/context.test.ts              M   +2 reclaim/audit tests
    test/agentChain.test.ts           M   one expectation now awaits the flush
  extension/
    esbuild.js                        M   four new entry points
    media/main.js                     M   renders path:line-endLine
    src/runnerEvents.ts               NEW RunnerEvent + safe-summary boundary
    src/providerEvents.ts             NEW four provider adapters
    src/presence.ts                   NEW PresenceStream
    src/contextDirectives.ts          NEW ```ripieno-context parser
    src/runners.ts                    M   onEvent, stream-json, OpenAI streaming/tools
    src/agentHost.ts                  M   event→presence, formatSharedContext, room tools
    test/providerEvents.test.js       NEW adapters vs fixtures
    test/presence.test.js             NEW send-side coalescing
    test/contextDirectives.test.js    NEW directive bounds
    test/eventStreamAgent.js          NEW fake event-emitting CLI
    test/fixtures/                    NEW 7 files — only the Claude one is a real capture
    test/agentHost.test.js            M   +3 end-to-end, +2 context-quoting
    test/openaiCompat.test.js         M   stream assertion changed + 6 new
    test/cliRunner.test.js            M   +4 declared-parser tests
    test/roomUi.test.js               M   +3 assertions
```

One pre-existing expectation changed: `agentChain.test.ts`'s "an unchanged state
is not rebroadcast" now awaits the coalescing window, because `setAgentState` is
rate-limited. Its original intent is still asserted.

## Where Phase 3 picks up

**Streaming drafts.** The type exists; nothing emits it, `handleRunnerEvent`
ignores it, and there is **no relay byte or rate limit for draft bytes**. Claude
Code has `--include-partial-messages` (verified present in `claude --help`) and
the OpenAI adapter already accumulates content deltas, so both are one `emit`
away. The real work is relay-side limits plus the ephemeral bubble and
reconciliation against the one authoritative transcript entry.

## Known gaps, stated plainly

- **Codex and Gemini adapters are unverified and dormant.** Neither binary was
  installed. Both are written to documented schemas; the Gemini *event-stream*
  branch is weaker still — best-effort, undocumented — while its final-object
  branch follows the documented `--output-format json` shape. Their presets
  **declare** `eventFormat` but their CLI arguments are deliberately unchanged,
  because the JSON flag names could not be verified and a wrong flag would break
  every newly created agent on creation. Those agents behave exactly as before
  until someone confirms the flag against a real binary. **This is the
  highest-value follow-up and it is a one-line preset change.**
- Only `claude-stream-json.jsonl` is a real capture (`claude 2.1.220`). The other
  six fixtures are documented-shape or speculative.
- `awaiting-approval` exists in the protocol and `publishActivity` accepts it, but
  the approval bridge never publishes it.
- **MCP tool-name collision, left deliberately.** `context_read`/`context_add` are
  registered by both `packages/mcp/src/index.ts` and
  `packages/extension/src/workspaceServer.ts`, while the latter namespaces
  everything else `workspace_*`. Renaming is wire-visible and would break agents
  already configured against the current names — a product call, not a cleanup.
- **`shutdown.test.ts` flakes, pre-existing.** Untouched by Phase 1 and Phase 2.
  Its `after()` calls `relay.close()` then immediately `rm -rf`s the temp dir
  while persistence is debounced by a second; a write landing mid-`rm` produces
  the observed `ENOTEMPTY`. It also binds a fixed `PORT = 8911` where every other
  suite uses port 0.
- This document's own plan file is unmodified: Phase 2 is **not** marked
  implemented in `live-collaboration-plan.md`, partly because of the dormant
  adapters above.
