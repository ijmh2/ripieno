# An unset workspace root, described as though it were set

Scheduled after Phase 5. Two sites still to fix; two are already fixed in the
working tree and described here so the set is understood as one defect rather
than four unrelated ones.

## The defect

In four places, code that has no working directory substitutes a confident
phrase for the absence and carries on. The phrase is always some variant of
"this workspace" — which reads as a directory that exists, and is in fact the
literal rendering of `undefined`.

None of the four is severe alone. Together they make a five-minute
configuration gap unfindable, because every surface reports success:

- the agent is told it has a workspace,
- the folder picker offers the workspace,
- the host command confirms the workspace is being shared,
- and the room announces that a member is hosting it.

Nothing is. The only component that behaves honestly is the one furthest from
the user — macOS, which refuses the write because `/` is sealed.

## How it presented

A member with no folder open in their editor window hosted the room's shared
workspace, saw the room confirm it, and asked their own agent to write a file.
The agent wrote it to `/Users/ivan/abc`, having inherited `/` as its working
directory. Asked to write "within this workspace", it answered:

> No — the room has no filesystem. It's a message channel; files I write land on
> this machine, and nothing I create is visible to other members' machines.

That is a coherent, fluent, and wrong description of the product, delivered to a
room. The agent had no way to distinguish "this room has no workspace host" or
"my own root is unset" from "rooms do not have workspaces", because every value
it could read had already been replaced by a plausible-looking default. An agent
that cannot tell absence from presence will describe absence as a design.

The follow-on cost is worse than the bug: a person debugging this reasonably
concludes the feature is broken, and the agent will keep confirming that.

## Still to fix

### 1. Hosting does not check that there is a folder to host

`packages/extension/src/extension.ts`, `toggleWorkspaceHost`.

The command guards `!relay || !currentRoom` and nothing else. With no folder
open it still shows the confirmation modal — which promises that "other members'
agents will be able to read, write and run commands in this folder" — sends
`claimWorkspace`, and the relay announces a host.

The claim is empty. The room now names someone as hosting a workspace that does
not exist, and every other member's agent will be told there is a shared
workspace to map locations against.

Refuse instead, and say which action fixes it: open a folder in this window.
Releasing must stay unconditional — a member whose folder closed still needs to
be able to drop a stale claim.

### 2. The folder picker offers a folder that is not there

`packages/extension/src/extension.ts`, `pickWorkingFolder`.

```ts
label: here ? `$(folder) ${here.name}` : "$(folder) This workspace",
description: "the folder open in this window",
```

When `workspaceFolders[0]` is undefined the row still appears, still described
as "the folder open in this window", and is still `picked: true` — the default.
Choosing it returns `{}`, so `spec.cwd` is assigned nothing and the agent is
configured back into the same broken state it was opened to repair.

This is the sharpest of the four, because it is the screen a person reaches
*specifically* to fix the problem, and its default option silently doesn't.

Either omit the row when there is no folder, leaving "Choose a folder…" as the
only option, or render it disabled and say why. Do not offer a default that
resolves to nothing.

## Already fixed, in the working tree

Uncommitted, and entangled with Phase 5 edits in the same files — see "State"
below.

### 3. A spawn with no directory inherits the extension host's

`packages/extension/src/runners.ts`, both `ClaudeCodeRunner.run` and
`CliRunner.run`.

`spawn` with `cwd: undefined` does not fail: the child inherits the parent's
directory, which for an extension host is `/`. macOS makes that read-only under
SIP, so it surfaced as `EROFS`. On Linux the same path is writable, and the
agent would have begun editing the filesystem root instead — the same bug with
no error at all.

Now returns `Promise.reject(missingWorkingDirectory())` before the process
exists. Rejection rather than a synchronous throw, because `run` is declared
`Promise<string>` and a caller using `.catch()` would otherwise receive an
exception it had no way to intercept.

### 4. The prompt named a directory that did not exist

`packages/extension/src/agentHost.ts`, `systemPreamble`.

`this.workingDirectory() ?? "this workspace"` told a workspace-capable agent it
had "file and shell access to this workspace" when the value was undefined.

A workspace agent with no directory is now told exactly that: it cannot read,
write or run anywhere, it must not guess a path or fall back to the process
working directory, and its owner sets one by editing the agent or opening a
folder in that editor window.

## A test-suite finding worth keeping

Every `AgentHost` construction in the extension tests — ten of them, across
`agentHost.test.js`, `agentReconnect.test.js` and `handoffAgentHost.test.js` —
passed no `cwd`, and `vscode-stub.js` sets `workspaceFolders: undefined`. The
shared `cliRunner` context had no `cwd` either.

So the entire end-to-end suite was exercising the inheritance path this bug
lives on, and passing. That is why four surfaces could carry the same defect
without a single test objecting: the tests agreed with the bug. All ten now pass
a real directory, and one test asserts the runner rejects rather than spawning.

When fixing sites 1 and 2, add coverage for the *absent* case specifically. The
present case was never the one at risk.

## The rule the four share

A missing value should be reported as missing. It should not be rendered as a
friendly noun phrase, defaulted to something plausible, or passed to an API that
will quietly choose for you.

This codebase already holds that line elsewhere and says so: `AgentActivity`
distinguishes "we do not know" from "idle" rather than rendering one as the
other; expired presence hides the coarse state too, because falling back to a
confident phase from minutes ago is "the same lie in a quieter voice"; and usage
reports `undefined` rather than zero for a provider that does not say, because
"£0.00 would be a confident lie about the cheapest agent in the room".

Workspace configuration is the one area that did not.

## State when this was written

Sites 3 and 4 are uncommitted in the working tree, mixed into files carrying
in-flight Phase 5 presence work, so they cannot be committed alone without
sweeping that in. Commit them once Phase 5 lands.

The suite stands at 661 tests, 3 failing. All three are Phase 5 presence tests
mid-edit — `presence.test.js` is unmodified and constructs no runners, so none
of them are related to anything described here.
