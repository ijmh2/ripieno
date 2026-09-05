# Shared work, Brain and continuation

This milestone extends the existing relay-owned Context lifecycle rather than
introducing a parallel persistence system. `ContextItem.collaboration` is typed
protocol data, persisted in room snapshots, replayed after reconnect and guarded
by the same request identities, optimistic versions and authenticated audit.
Older plain context remains readable as Brain memory.

## User flows

- Select code in the hosted shared workspace and run **Add Shared Code Comment**
  from the editor context menu. It captures the shared relative path, host,
  selection and full-file SHA-256 digest. Add the discussion title and detail.
  In Room, **Manage / reply → Assign human owner** turns the comment into an
  assigned task while preserving its code anchor and original author.
- **New task** creates human-owned work. Manage it to assign another human,
  advance progress, or link a durable room goal and a currently held work claim.
  The assignee may progress assigned work without rewriting its description,
  dependencies or ownership. Releasing a claim does not delete the task or
  prevent subsequent progress; the panel identifies its expired claim link.
- **New plan** takes an ordered list of steps. The plan's management dialog can
  set individual step owners, edit dependencies and update shared progress.
  The relay rejects missing dependencies, cycles and advancing a dependent
  step before its prerequisites finish. Completing all steps marks the plan
  done; goal completion remains an explicit human action through existing goals.
- **Remember** adds durable Brain memory. **Remember Selection in Brain** also
  anchors it when the active selection maps to the current shared tree. Search
  titles, detail, tags and assignees; filter plans, tasks, comments, memory,
  proposed context or retired items. Proposals remain visibly unverified until
  a human accepts them. Accepted/proposed records can be archived by their
  author or room owner.
- **Add discussion reply** creates another versioned record linked by `replyTo`.
  The relay stamps the authenticated author; it never trusts an `@handle`
  inserted into a shared body as reply provenance. Replies do not mutate the
  original discussion or inherit permission to edit its task.
- **Handoff recovery** shows pending, assigned, claimed, started, failed,
  outcome-unknown and expired transfers. Recipient-only accept/retry actions
  choose an owned attached agent and use the existing nonce/version guarded
  relay lifecycle. Retry explicitly warns that prior execution may have happened.
  Expired offers need a new offer; they are not silently retried.
- **Continue in Amoeba** saves an explicit JSON continuation bundle, then offers
  the verified public website. It is a manual export: no invented deep link,
  claimed API import, provider-session transfer or automatic site publication.

## Authority and freshness

Collaboration creation/editing is human-only. An assigned person can change
only progress on the work they own; only the record author or room owner can
change its content/ownership. Plan text uses existing credential redaction;
credential-like anchor paths are refused instead of being mapped to another
file. Relay validation is necessary even though native dialogs guide input.

An anchor is opened only when the current host matches and the full document
still hashes to its saved digest. Changed files, host changes, missing files and
unmapped private files never silently navigate stale lines. Anchor metadata is
immutable after creation. Native dialogs revalidate the room, connection,
identity and workspace before writing their result.

Agent context includes quoted shared-work metadata. `context_read` can read a
complete item by exact id, including a large plan; default prompt context stays
bounded and the tool provides an item index. Plans and memory are shared
reference data, never promoted to higher-priority instructions.

## Limits

- Anchors detect change rather than rebasing lines. After edits, a person reviews
  current code and creates a fresh anchored record; no stale coordinate is
  presented as current truth.
- Discussions use linked attributed records in the shared panel, not VS Code's
  native inline comment-thread widget. The editor context menu is the creation
  entry point.
- Plans contain at most 40 steps; each record's detail remains bounded at 4,000
  characters, and the existing room context bound is 200 live records. Replies
  count toward that same bound.
- Work claims are leases and task/plan progress is durable. Completion of a plan
  is not a claim that an agent ran, a file was written or a goal was completed.
- Export contains shared content, including user-authored task descriptions. It
  omits private provider configuration, raw transcripts and frozen provider
  continuation data, and requires manual review/use in the destination.

## Verification

- Full monorepo test run: **748/748 passed** before the final additional
  selection/navigation, plan-invariant, raw-wire and disk-roundtrip regressions.
- Expanded focused suite: **32/32 passed**, including authenticated raw WebSocket
  mutation checks and actual `FileRoomStore` JSON persistence/replay.
- Latest extension-only native/UI suite: **20/20 passed** after capability
  handshake ordering and export redaction changes.
- Full monorepo typecheck passed; latest extension typecheck and `git diff
  --check` passed after the final extension edits.
- A separate compact terminal-receipt regression covers completed, failed and
  outcome-unknown receipt replay without a second claim or provider execution.

The test counts above describe the runs at implementation handoff. The final
review/package owner should record any later full-suite run with the package.
