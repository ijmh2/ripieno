# Ripieno: first Amoeba teaser milestone

Implemented in `/Users/ivan/Documents/Codex/ripieno-yc-multiplayer` on branch `codex/yc-multiplayer`. Changes remain local and uncommitted. The existing Phase 6 proposed-diff changes are retained in the build.

## What is ready

- A live team board in **Ripieno: Open Full Room Panel**, with each agent's owner, current reported task, shared files, and an inspector link.
- Human-owned work claims. A claim can link to an attached agent and an active room goal, or be held by a person without an agent. The relay allows only one holder per linked goal.
- Exact shared-file and matching-task warnings, including a warning while composing a claim. Live editing/proposals are distinguished from declared intentions. Private file copies, historical actions, expired observations, and disconnected state are excluded from live overlap evidence.
- Server-owned identity, bounded fields and collections, renewal leases, reconnect retry protection, and role checks. A person cannot claim another person's agent, release their work, or renew their lease. Viewers can inspect, but cannot claim.
- Claims are released on the owner's last human connection leaving, role revocation, linked goal completion/pause, or lease expiry. Shared-file claims clear when the workspace host changes. With multiple same-account editors, only the originating editor renews its own claims; a crashed editor's claim expires within 90 seconds plus the sweep interval.
- Current claims reach extension-hosted agents as bounded, quoted participant data before each turn. They do not grant permission or interrupt a running provider.
- An offline board reports unavailable claims and unverified activity, rather than pretending nobody is working.

Claims are advisory intentions, not file locks. File warnings compare exact paths in the room's single shared workspace; task matching normalizes case and whitespace, not semantic meaning. This milestone does not automatically prevent writes, split work, or resolve merge conflicts. Warnings currently compare different people's work; the same person's own agents are grouped together.

## Try it

1. In VS Code or a compatible editor, choose **Extensions: Install from VSIX…** and select `ripieno-team-board.vsix`. Reload the editor if requested.
2. Join a room and run **Ripieno: Open Full Room Panel**. Embedded solo mode includes the new relay. A shared deployment must also be rebuilt from this checkout; an older relay is explicitly shown as unsupported for claims.
3. Host a folder. Claim a task and list an exact path such as `src/auth.ts`. Selecting an agent is optional.
4. Have a second member claim the same file. Confirm that the warning identifies both people. Use its inspector buttons to examine reported agent activity.
5. Release your claim and verify the warning clears when no other overlap remains. Disconnect and verify that claiming is disabled and the board reports unavailable live state.

## Verification

- Full monorepo typecheck passed during implementation; the extension typecheck was repeated after the final room-switch changes.
- Full regression suite: 715 tests passed, zero failures. Run on local Node 25.8.0.
- Added coverage includes raw WebSocket impersonation attempts, viewer/peer permissions, lease expiry/renewal, host changes, same-goal arbitration, restart behavior, stale/private activity exclusion, and actual fake-runner prompt delivery/removal.
- The actual HTML/CSS/webview script was exercised in a browser against an in-memory test room: create, preflight warning, confirmed overlap, correct inspector selection, release, and disconnected states. This was not a two-editor acceptance run or a live Claude/Codex provider session.
- The VSIX archive was checked for integrity and inclusion of the new runtime/UI code.

## Next milestone

Provider event verification is now implemented in the [provider activity milestone](provider-activity-milestone.md). Anchored code comments, richer shared plans/memory, durable handoff recovery, and migration into the Amoeba IDE remain future work. No extension was installed into your editor and nothing was pushed or deployed.
