# Multiplayer Agent

A shared AI agent room, in your editor. One conversation, several people, and an
agent that genuinely sees a single chat — and knows who said what.

The naive version of this is a shared login. The point here is **provenance and
scoping**: every message the agent receives is attributed to its author, and every
workspace action runs on the asking member's own machine, under their own
permissions.

> Status: Phase 0. The relay, protocol, room core and extension are built; the
> live end-to-end run needs Anthropic credentials (below).

## Layout

| Package | What it is |
|---|---|
| `packages/protocol` | The WebSocket contract shared by both sides. No Anthropic types. |
| `packages/relay` | Node server. Owns the API key, runs one shared agent session per room. |
| `packages/extension` | VS Code extension: the room UI and the local tool bridge. |
| `infra/` | `agent.yaml` and `env.yaml` — version-controlled agent configuration. |

The relay splits into a **room core** (membership, transcript, provenance,
addressing) and a **driver**. `HostedDriver` runs one shared session against an
org API key. The core never assumes it owns the agent loop, so a later BYO driver
— each member's own local agent over MCP — is a driver swap, not a rewrite.

## Two modes

| | Hosted | BYO |
|---|---|---|
| Who runs the agent | One shared CMA session, owned by the relay | Each member's own local agent |
| Product | One agent, genuinely one chat | N agents, one shared brain |
| Needs | API key, agent + environment resources, credit balance | Nothing — each member's own subscription |
| Tokens | One context, cost per turn regardless of headcount | N× — every agent re-reads shared history |

`MPA_MODE=byo` is the default because it needs no credentials at all. Swapping
between them is a driver swap ([driver.ts](packages/relay/src/driver.ts)); the
room core, protocol and UI are identical.

## Running in BYO mode (no credentials)

```sh
npm install && npm run build
npm start -w @mpa/relay          # BYO is the default mode
```

Then attach your own Claude Code as your agent. [.mcp.json](.mcp.json) already
declares the server — edit `MPA_ROOM` / `MPA_HANDLE` / `MPA_NAME` and start
Claude Code in this directory. It gains three tools:

| Tool | What it does |
|---|---|
| `room_read` | Messages you have not seen since your last read, each labelled with its author |
| `room_post` | Post to the room, attributed as "<Your Name>'s agent" |
| `room_roster` | Who is present, and who has an agent attached |

Your agent's replies land in the shared transcript in your colour, so the room
still reads as one conversation and divergence between members' agents is
visible rather than confusing.

## Prerequisites (hosted mode only)

```sh
brew install anthropics/tap/ant
xattr -d com.apple.quarantine "$(brew --prefix)/bin/ant"
ant auth login          # or: export ANTHROPIC_API_KEY=...
```

## One-time setup

The agent and environment are **persistent, versioned resources**. Create them
once and store the IDs; never create them per run.

```sh
npm install
npm run build

export MPA_AGENT_ID=$(ant beta:agents create < infra/agent.yaml --transform id -r)
export MPA_ENVIRONMENT_ID=$(ant beta:environments create < infra/env.yaml --transform id -r)
```

To change the agent's behaviour later, **update** rather than create — each update
is a new version, and running sessions keep the version they pinned:

```sh
ant beta:agents update --agent-id "$MPA_AGENT_ID" --version N < infra/agent.yaml
```

## Running

```sh
npm start -w @mpa/relay      # ws://localhost:8787
```

Then `F5` in `packages/extension` to launch an Extension Development Host, and
run **Multiplayer Agent: Join Room**. For a real multiplayer test, open a *second*
window on a different folder and join the same room code.

## Tests

```sh
npm test -w @mpa/relay
```

33 tests, no network or credentials required. They cover the places correctness
bugs hide:

- **provenance envelope** — including that a member cannot close the tag to
  impersonate someone else
- **event dedupe** — overlaying fetched history on the live stream after a
  reconnect must not double-render
- **idle gate** — `session.status_idle` is transient and fires while the session
  waits on *us*; breaking on it unconditionally strands every tool call
- **tool addressing** — unknown, missing and offline handles each produce a
  corrective error the agent can act on
- **room fan-out** — two members see each other's messages, a joiner gets the
  transcript, presence changes re-brief the agent, and a tool call reaches only
  the addressed member

The fan-out suite is the credential-free half of Phase 0 verification: it proves
the multiplayer path through a fake driver, leaving only the live session to
check by hand.

## Design notes worth knowing before changing things

- **Stream before send.** The session stream only delivers events that occur
  after it opens.
- **Reconnect consolidates.** SSE has no replay, so every reconnect overlays
  `events.list()` history and dedupes by event id. Without it, a relay restart
  during a pending tool call deadlocks the room permanently.
- **The agent addresses tools by handle.** `agent.custom_tool_use` carries
  nothing identifying a member, so every workspace tool takes a required
  `handle` and the relay validates it — returning a corrective error the agent
  can retry against, rather than stalling.
- **An offline member would otherwise deadlock the room.** Pending calls carry a
  timeout that answers the agent with an error, and offline members are dropped
  from the roster it sees.
- **The roster goes via `events.send`, not `initial_events`** — a session's
  `initial_events` accepts only `user.message` and `user.define_outcome`.
- **Cost scales with turns, not people.** One shared context per room. Per-turn
  usage is logged from `span.model_request_end`.

## Security boundaries

- The API key lives only in the relay. No editor client ever sees it.
- Workspace tools execute either in the member's own VS Code, under their
  permissions, or in the shared-workspace container. Both go through
  `@mpa/workspace-core`, so there is exactly one implementation of the path
  checks — `resolveSafePath` resolves the deepest existing ancestor before
  deciding, so a symlinked parent cannot be used to create a file outside the
  workspace, and `confineToWorkspace` resolves each result individually rather
  than trusting its parent directory. Both of those started out subtly wrong and
  are now covered by tests written from the exploit.
- In the editor, shell commands are gated behind a modal showing the exact
  command. In the container there is nobody to ask, so an allowlist decides.
- Only the member a tool call was addressed to may answer it. Without that, an
  authenticated member could still forge the contents of someone else's private
  workspace into the shared context — which is exactly the provenance this sells.
- The webview runs under `default-src 'none'` with a nonced script and renders
  all agent text escape-first.

### The container's command allowlist is a trust decision, not a sandbox

`MPA_ALLOWED_COMMANDS` is empty by default and a container with no allowlist
runs nothing. If you set one, understand what you are choosing.

An agent can write files, including project files. So allowlisting `npm test`
means an agent can write a `package.json` whose test script is anything at all,
and then legitimately ask for `npm test`. The same is true of every build tool
worth allowlisting. No amount of blocking shell metacharacters changes this —
the escape is through the allowed program's own configuration, not through the
command string.

**Allowlisting a build tool means trusting everyone in the room with code
execution in that container.** That is often a perfectly reasonable thing to
choose. It should not be chosen by accident.

What the container does instead is make the prize small:

- `MPA_*` variables are stripped from every command's environment, in both
  hosts. Holding `MPA_WORKSPACE_TOKEN` would let someone impersonate the shared
  workspace and feed every agent in the room a different codebase.
- In the container specifically, provider API keys and anything ending in
  `TOKEN`, `SECRET` or `PASSWORD` are stripped too, because nobody is watching
  and the room could simply ask an agent to run `env`. On a member's own machine
  they are kept: a human approved that command, and stripping their environment
  would break ordinary work to prevent something they were present for.
- The container is disposable and everything in it is either committed and
  pushed or reproducible from the repository.

`MPA_ALLOW_ALL_COMMANDS=1` additionally requires `MPA_I_UNDERSTAND_THE_RISK=1`,
because "the room can run anything here" should take two deliberate actions.
