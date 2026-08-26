# Phase 4 handoff — full Room editor panel

Written for the Phase 5 implementer. Read
[`live-collaboration-plan.md`](./live-collaboration-plan.md) and
[`phase-3-handoff.md`](./phase-3-handoff.md) first.

## State when this was written

Phase 4 is implemented by the commit containing this document on
`codex/yc-multiplayer`; its parent is Phase 3 commit `618118f`. Claude's
high-effort read-only review green-lit Phases 3 and 4 after the corrections
below. Do not infer push status from this document.

Verification completed while implementing:

| Check | Result |
|---|---|
| Focused Phase 4 model, UI and existing Room UI tests | 15/15 pass |
| Extension full suite | 266/266 pass |
| Protocol suite | 23/23 pass |
| Relay client suite | 2/2 pass |
| Workspace core suite | 53/53 pass |
| Relay suite | 273/273 pass |
| Workspace host suite (isolated) | 43/43 pass |
| All test suites combined | 660/660 pass |
| Extension build | exit 0 |
| `npm run typecheck` | exit 0 across all seven workspaces |

The root `npm test` command runs workspace suites concurrently. In this pass its
workspace-host integration group collided or stalled while other loopback relay
tests were active, so that umbrella process was interrupted after the unrelated
suites passed. Running workspace-host in isolation immediately passed 43/43;
the combined 660/660 total above is the sum of the independently completed
suites. Port-binding suites need sandbox permission.

## High-effort review corrections

A read-only Claude review after the first implementation found six issues. All
were reproduced, corrected and covered before this handoff was finalised:

- Claude `text_delta` frames carrying a Task sub-agent `parent_tool_use_id` are
  rejected, so internal sub-agent narration cannot appear as the main agent's
  provisional reply. The guard accepts neither the CLI wrapper nor nested event
  location as a route around the boundary.
- Aggregate room rate and byte saturation now shed only the excess fragment.
  They do not cancel a compliant agent's existing preview or forfeit the relay
  id used for final-row reconciliation. Per-agent violations still cancel.
- The editor panel uses the exact eight HSL hue angles from the sidebar, so
  member colour remains a consistent identity signal across both surfaces.
- Follow mode automatically enables the followed agent's new status filter and
  announces why, rather than silently selecting a different visible agent.
- Passive snapshot rendering restores the focused exact-agent tab and rail
  scroll position after DOM reconciliation.
- The repeatedly-rendered detail card is no longer a live region. Only the
  dedicated bounded announcements region speaks follow changes.

## Product surface

The sidebar's Room, Context and Agents tabs are unchanged and remain the compact
awareness surface. A new **Ripieno: Open Full Room Panel** command, also exposed
in the Room view title, creates one editor-sized webview panel and reveals the
same panel on later invocations.

The panel contains:

- a room overview for people, agents, goals, handoffs, durable Work and shared
  context;
- a horizontally scrollable exact-agent tab rail, with every tab labelled by
  both agent and owner;
- active, idle and not-reported status filters;
- exact-agent follow mode that persists as local webview state and announces
  safe activity updates;
- current task, goals/handoffs, working set, recent actions, usage and
  capability/permissions cards; and
- a responsive one-column layout at narrow editor widths.

The rail follows the ARIA tabs pattern: one roving `tabindex`, `aria-selected`,
an associated `tabpanel`, Left/Right/Home/End navigation and visible focus.
Filters and follow use `aria-pressed`, status is never conveyed by colour alone,
and live follow announcements use a polite status region.

## State and identity boundary

`RoomViewProvider` remains the extension-host source of truth. It stores the
latest roster, goals, context, handoffs, Work and usage snapshots and sends a
fresh display model to the editor panel when relevant state changes. The panel
does not connect to the relay or provider directly.

`buildRoomPanelSnapshot` in `roomPanelState.ts` flattens the relay roster into
tabs keyed only by `AttachedAgent.id`. Actions, usage and handoffs are joined by
that exact id. Labels are display text and never identity keys.

Current task is deliberately conservative:

1. relay-approved `AgentPresence.summary`, when present;
2. a relevant open handoff task;
3. the coarse shared phase with an explicit “no task summary reported”; or
4. “No current task reported”.

It never infers a task from private prompts, transient response drafts or
transcript prose. The working set is the shared presence path followed by up to
five distinct recent Work targets for that exact agent. It is labelled as an
observable working set rather than a keystroke cursor.

## Local permissions and privacy

The relay does not currently share provider settings or permission policy.
Remote agents therefore show only their relay-visible declared capability.

For an agent owned by the signed-in member, the extension may add its local
provider, model, project folder name, permission description and response mode.
This match requires both:

- `agent.owner === you.handle`; and
- exact equality with the local id or `${you.handle}::${localId}`.

The data is rendered under **Private to this editor** and never sent to the
relay. A remote agent with the same local suffix or label cannot receive it.
Provider reasoning, provider diagnostics, raw terminal output, tool JSON,
credentials, provider sessions and Phase 3 drafts are not fields in the panel
model. All model-controlled strings render through `textContent`; the panel
script does not use `innerHTML`.

## Files added or materially changed

```text
README.md
docs/live-collaboration-plan.md
docs/phase-4-handoff.md
packages/extension/package.json
packages/extension/esbuild.js
packages/extension/src/extension.ts
packages/extension/src/roomView.ts
packages/extension/src/roomPanelState.ts
packages/extension/media/roomPanel.js
packages/extension/media/roomPanel.css
packages/extension/test/roomPanelState.test.js
packages/extension/test/roomPanelUi.test.js
```

## Known gaps and Phase 5 seam

- Follow mode currently keeps one exact-agent tab selected and announces safe
  activity. It does not open files, move the editor or draw decorations. Those
  actions need Phase 5's shared-workspace mapping and opt-in boundary.
- A working-set target comes from current safe presence or durable Work. Action
  targets are intentionally not guessed to be paths, so commands may appear as
  labelled work targets.
- Remote permissions remain private. A future room policy could share a bounded
  declarative permission class, but must be relay-derived and must not expose
  provider configuration or credentials.
- The panel has pure state-model coverage and static accessibility/security
  assertions, but no VS Code integration harness currently mounts and
  screenshots the webview. Perform a manual visual pass in light, dark and
  high-contrast themes before release.
- The Claude Task sub-agent exclusion is covered for both plausible
  `parent_tool_use_id` locations, but still needs confirmation against a fresh
  real `--include-partial-messages` capture before being called capture-backed.
- Phase 5 should reuse `RoomPanelAgent.agentId` and `activity.path/line/endLine`.
  It must not treat independent private repositories as a shared coordinate
  system; exact navigation and decorations are valid only for the single shared
  workspace or an explicit owner opt-in.
