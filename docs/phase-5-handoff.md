# Phase 5 handoff — scoped locations and editor presence

Written for the Phase 6 implementer. Read
[`live-collaboration-plan.md`](./live-collaboration-plan.md) and
[`phase-4-handoff.md`](./phase-4-handoff.md) first.

## State when this was written

Phase 5 is implemented but not committed or pushed. The current branch head is
`bc91f99` on `codex/yc-multiplayer`; Phase 4 itself is `c4bc8a0`. Do not infer
remote state from this document. The missing-workspace-root follow-up is now
included in this phase rather than left behind it.

The working tree also contains Claude's adjacent unset-working-directory fix:
workspace runners now refuse to inherit the extension host's process directory,
and the prompt reports a missing root honestly. That work is documented in
[`unset-workspace-root.md`](./unset-workspace-root.md); its host and folder-picker
sites are now fixed by the workspace creation flow below.

Verification completed while implementing:

| Check | Result |
|---|---|
| Full monorepo `npm test` with loopback permission | 683/683 pass |
| Protocol suite | 23/23 pass |
| Relay client suite | 2/2 pass |
| Workspace core suite | 53/53 pass |
| Relay suite | 277/277 pass |
| Workspace host suite | 43/43 pass |
| Extension suite | 285/285 pass |
| Latest workspace-host/panel focused tests | 17/17 pass |
| `npm run typecheck` | exit 0 across all seven workspaces |
| Production extension build | exit 0 |

The loopback relay, HTTP and workspace-host integration tests cannot bind ports
inside the default sandbox. The full run above used explicit local-network test
permission; the earlier sandbox run failed with `listen EPERM`, not assertions.

## Coordinate and privacy model

`AgentPresence` and `AgentActivityMsg` now carry an optional
`locationScope: "shared" | "private"`. A path without one is discarded while
phase and summary remain visible. This intentionally makes older clients coarse
rather than treating a same-looking filename in independent clones as the same
document.

The extension chooses scope at the reporting owner:

1. An exact known tool in the bundled `workspace` MCP namespace addresses the
   room's current shared tree and receives a `shared` hint.
2. A native provider location is `shared` only if this member owns the current
   workspace claim and that agent's actual root exactly equals the open editor
   root being hosted.
3. Otherwise the location is `private` only when the owner enabled
   `ripieno.sharePrivateWorkspacePresence`, which defaults to false.
4. Without one of those proofs, only the safe phase and summary leave the
   machine.

The bundled MCP allowlist uses the real Claude names
`mcp__workspace__workspace_read_file`, `workspace_write_file` and
`workspace_edit_file`. A merely similar or provider-invented prefix does not
grant shared scope. Both reporting host and relay reject absolute paths,
control characters and `..` traversal even when a scope is present.

The relay remains authoritative over room topology. It accepts `shared` paths
only while a host exists and strips all shared path/range fields from live and
coalesced presence when the host changes, releases or disconnects. `private`
paths stay explicitly marked so another client never maps them onto its own
copy.

## Navigation boundary

The full Room panel renders a location as a button only when this extension can
map its coordinate system. The webview sends
`{ type: "openAgentLocation", agentId }` and never sends a path, URI or range.
The extension re-finds that exact id in the latest relay roster and resolves its
current presence again before opening anything.

Shared locations open the host's ordinary local file when this member is the
host, or the existing read-only `ripieno-workspace:` filesystem when somebody
else hosts. Opted-in private locations open only for the owning signed-in member
and resolve against that exact local agent's configured root. Every resolution
rejects root escape. A reported 1-based inclusive line range is clamped to the
document, selected and revealed; a path-only location opens without fabricating
a line.

## Workspace creation and honest persistence state

The host command never claims an absent coordinate system. With a local folder
open it confirms that exact name and path. From an empty editor it offers either
**Create and host** or **Choose existing folder**. Creation uses a sanitized room
name under `Documents/Ripieno`, advances through `-2`, `-3`, and so on instead
of adopting an existing directory, attaches the folder to the editor, and sends
`claimWorkspace` only after attachment succeeds.

The exact hosted root is tracked for file watching, presence mapping and lease
lifecycle. Removing that folder releases the relay claim immediately; closing
the whole host connection is still covered by the relay's existing presence
cleanup. Agent working-folder setup also omits the old fictional "This
workspace" choice when no folder is open.

The full Room panel and status-bar tooltip distinguish **Saved locally**,
**Live from @host** and **Workspace offline**. They explicitly say that no
durable checkpoint has been reported. This is a UI seam for later persistence,
not a claim that Phase 5 performs Git commits or pushes.

## Decorations and lifecycle

`PresenceDecorations` owns eight text decoration types using the same HSL member
hues as both Room surfaces. It paints whole-line, member-coloured active ranges
only in already-visible documents whose URI matches the scoped presence. Several
agents of one member are aggregated instead of overwriting one another.

The manager rebuilds decorations from each authoritative roster snapshot, so
idle, detached and expired agents clear naturally. A local connection loss
withdraws all decorations and exact coordinates until a fresh joined/roster
snapshot arrives. Workspace-host changes clear shared coordinates in the relay.

Filesystem invalidations are stricter: the path and range disappear locally at
once and remain suppressed until that exact agent's `updatedAt` is newer than
the invalidation. A newer observation from a different agent does not revive an
older agent's stale range.

## Files added or materially changed

```text
README.md
docs/live-collaboration-plan.md
docs/phase-5-handoff.md
packages/protocol/src/index.ts
packages/protocol/test/presence.test.ts
packages/relay/src/server.ts
packages/relay/src/room.ts
packages/relay/test/context.test.ts
packages/relay/test/presence.test.ts
packages/extension/package.json
packages/extension/esbuild.js
packages/extension/src/agentHost.ts
packages/extension/src/extension.ts
packages/extension/src/presence.ts
packages/extension/src/presenceDecorations.ts
packages/extension/src/presenceLocationPolicy.ts
packages/extension/src/workspaceHosting.ts
packages/extension/src/providerEvents.ts
packages/extension/src/roomPanelState.ts
packages/extension/src/roomView.ts
packages/extension/src/runnerEvents.ts
packages/extension/media/roomPanel.js
packages/extension/media/roomPanel.css
packages/extension/test/presence.test.js
packages/extension/test/presenceDecorations.test.js
packages/extension/test/presenceLocationPolicy.test.js
packages/extension/test/workspaceHosting.test.js
packages/extension/test/providerEvents.test.js
packages/extension/test/roomPanelState.test.js
packages/extension/test/roomPanelUi.test.js
packages/extension/test/vscode-stub.js
```

## Known gaps and Phase 6 seam

- Presence remains a range/working-set signal, not a character caret or a claim
  that an agent types incrementally. Path-only providers get navigation but no
  invented decoration.
- Opening a remote virtual file needs one of this member's agents attached,
  because existing remote filesystem requests borrow its authenticated agent
  connection. If none is attached, the filesystem reports that requirement.
- Private presence sharing is one owner-wide boolean today. Per-agent summary,
  shared-location and off controls remain Phase 7.
- The panel and decoration model have state, boundary and static UI tests, but
  no VS Code integration harness currently screenshots a real webview/editor
  combination in light, dark and high-contrast themes.
- Codex and Gemini event adapters still need capture-backed verification against
  current installed binaries, as recorded in the Phase 2 handoff.
- Phase 6 proposed diffs must reuse the exact agent id and scoped document
  mapping here, but must remain temporary display. Only the existing approval
  and durable Work path may apply or prove a change.
