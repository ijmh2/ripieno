# Ripieno

> *ripieno* — in a concerto grosso, the full ensemble, as against the soloists.
> Several parts, sounding together, each still its own line.

A shared workspace in your editor where several **people** and several **AI
agents** work on one codebase at once — **self-hosted**, with **each person
bringing their own agent** on their own subscription, from **any vendor**.

Everything is attributed to a named actor: a specific agent belonging to a
specific person, rather than whoever's machine happened to run it.

The naive version of this is a shared login, which gives the agent one anonymous
view of a team: it cannot tell agreement from disagreement, whose preferences to
honour, or whose filesystem the next write lands on. Here every message the agent
receives carries its author as structure the relay maintains, and every workspace
action runs on the asking member's own machine under their own permissions.

There is no hosted service and there will not be one. A relay sees every message
and routes every tool call; asking you to trust an unaudited third party with
that would contradict the argument on the first page. You run your own, or you
run none at all — solo mode needs no relay, no account and no token. See
[docs/self-hosting.md](docs/self-hosting.md).

Two agents belonging to two different people can write to the same repository
concurrently, and `git log` names each of them correctly:

```
$ npm run demo:provenance

$ git log --pretty='%<(16)%an  %s' -5

  Alex's agent      Mention the limits in the README
  Sam's reviewer    Write down both limits
  Mira's coder      Bound the transcript
  Sam's reviewer    Cover the rate limit
  Mira's coder      Add rate limit to relay
```

That column normally holds one name — whoever's machine ran the commit. It is
real output: the demo runs the container's own code against a real repository,
writing concurrently rather than in turn, because git serialises on
`.git/index.lock` and losing that race is how five writes in six once vanished.

## Status: what's real

Honest, because an unknown repository has no other way to earn it.

| | |
|---|---|
| **Works, used** | Solo mode, invite links, rooms over a deployed relay, several agents per member across providers, remote tool execution with approval, action log, per-agent usage, verified GitHub identity, owner/member/viewer roles, room history that survives a redeploy |
| **Built and tested, never deployed** | The shared-workspace container (`packages/workspace-host`) — 43 tests including real git integration, and it has never run anywhere but a test |
| **Not on this branch** | Hosted mode. Built against the driver interface, compiles, unit tests pass — and it has never run against a live Managed Agents session, so it lives on the `hosted` branch rather than being described here as a feature |

There are 348 tests (`npm test`) across the five packages that have them
(`relay-client` and `mcp` do not), and six exploitable defects found by an
adversarial audit have been fixed, each with a regression test written from the
exploit.

The more useful thing to say is where tests did *not* help. Several bugs were
found only by two people using it, and several more by an outside reading of the
whole repo — a role menu whose `when` clause named a view that does not exist, so
the feature rendered for nobody; an empty `activationEvents`, so invite links
only worked if the extension was already awake; a permission setting that
promised to ask before writes and mapped to a mode that pre-approves them. None
of those are reachable from a unit test of the code behind them, and all three
had passing tests underneath. The newest tests go after exactly that: one runs a
real relay, a real agent host and a real subprocess and asserts on the prompt the
agent was handed (it immediately found that every CLI agent had been silently
running Claude Code); another checks the extension manifest against itself.

## Try it in one minute, alone

Nothing to deploy, no account, no token.

```bash
npm ci && npm run package        # → dist/ripieno-0.0.1.vsix
```

Install the `.vsix` (Extensions → `…` → Install from VSIX), then run
**Ripieno: Join Room** and type any room code. Leave `ripieno.relayUrl`
empty and the extension runs a relay on this machine.

It is deliberately the *same* relay a team shares, not a reduced imitation —
same rooms, same attributed transcript, same tool routing, same action log, and
history that survives a reload. Solo is where people form their opinion of the
product, and a cut-down version would teach them the wrong thing about it.

Attach an agent from the **Rooms & Agents** tree and talk to it.

## Adding people

Set `ripieno.relayUrl` to a relay you can both reach, then **Copy Invite Link**. The
link carries the relay, the room and the token; clicking it confirms what is
being joined before anything happens, and the token goes to the editor's
SecretStorage rather than `settings.json` — settings are one `git add .` from
being published.

Run a relay anywhere Node runs:

```bash
RIPIENO_TOKEN=$(openssl rand -hex 24) RIPIENO_DATA_DIR=./data npm start
```

`RIPIENO_TOKEN` gates who may reach it. `RIPIENO_DATA_DIR` is where room history lives —
without it a restart empties every room. `RIPIENO_REQUIRE_GITHUB=1` makes the relay
verify identities rather than believing the handle a client sends.

## Bring your own agent

Each member attaches their own agent, on their own subscription, running on their
own machine. Supported out of the box: **Claude Code** (full workspace access),
any **OpenAI-compatible** endpoint (Grok, Kimi, DeepSeek, Together, Groq, a local
Ollama), and arbitrary **CLI** agents.

Capability differs and the room says so rather than implying otherwise: a Claude
Code agent can read and write files and run commands; a chat-API agent can only
talk. Presenting both as "an agent" without distinction would let somebody ask
Grok to fix a file and get a confident answer while nothing happened.

Usage is per agent, and in BYO it is **turns and tokens, never a price**. Claude
Code reports a dollar figure on a subscription too, where it is what those
tokens would have cost on the API and nobody is billed a penny of it — and next
to a colleague's agent on a different plan, the two figures do not mean the same
thing.

An agent can also join over MCP instead — copy `.mcp.json.example` to `.mcp.json`
and fill in `RIPIENO_ROOM` / `RIPIENO_HANDLE` / `RIPIENO_NAME`. That path gets ten tools
(`room_read`, `room_post`, `room_roster`, `room_actions` and six `workspace_*`).

## The shared workspace

An agent normally works in its owner's own directory. Point it at **the room's
workspace** instead and it acts on whichever machine is hosting — another
member's, or a container. Writes raise a diff on the host's machine naming the
agent that asked, and land in the room's action log so other agents can see what
has already been done rather than redoing it.

The container (`packages/workspace-host`) is the version that outlives everyone:
it clones a git repository, serves the same tool calls, and commits each write as
the agent that made it, so provenance ends up in `git log` rather than only in
the room. Built and tested; not deployed anywhere yet. Run it locally with
`npm run build:workspace && npm run start:workspace`.

## Layout

| Package | What it is |
|---|---|
| `packages/protocol` | The WebSocket contract. Pure types and helpers, no dependencies |
| `packages/relay` | The server: membership, transcript, provenance, tool routing, persistence, identity, roles |
| `packages/relay-client` | The WebSocket client both the extension and the container use |
| `packages/workspace-core` | The workspace tools and the path-confinement boundary, shared by the editor and the container |
| `packages/workspace-host` | The container that can host a room's workspace |
| `packages/extension` | VS Code: the room UI, agent hosting, approvals, the shared-workspace view |
| `packages/mcp` | An MCP server, so an agent can join a room without the extension |

The relay splits into a **room core** — membership, transcript, provenance,
addressing — and a **driver** that turns room events into agent turns. The core
never assumes it owns the agent loop. `ByoDriver` coordinates each member's own
agent; a `HostedDriver` running one shared session was built against the same
interface, which is the evidence the seam is real rather than hypothetical.

## Security boundaries

- **Path confinement is one implementation**, in `workspace-core`, used by both
  the editor and the container. `resolveSafePath` resolves the deepest existing
  ancestor before deciding, so a symlinked parent cannot be used to create a file
  outside the workspace; `confineToWorkspace` resolves each result individually
  rather than trusting its parent directory. Both of those started out subtly
  wrong and are now covered by tests written from the exploit.
- **Only the member a tool call was sent to may answer it.** Without that, any
  member could forge the contents of somebody else's workspace into an agent's
  context. Request ids are minted by the relay, never taken from a client — two
  clients each counting from zero used to collide and deliver one agent's file to
  another.
- **Writes and commands are approved by the member whose machine runs them**, and
  the approval names the agent that asked and whose workspace it will touch.
- **Roles are enforced in the relay**, not the UI. Hiding a button is
  presentation; anyone can send the message the button would have sent. They only
  *mean* something with `RIPIENO_REQUIRE_GITHUB`, because a handle is otherwise
  self-asserted — enforced regardless, so that turning verification on is
  sufficient.
- **Identity fails closed.** If GitHub cannot be reached, joins are refused
  rather than trusted; "cannot check" is the state the feature exists to replace.
- **Messages are bounded** — 1 MB frames, 32k characters — because the transcript
  is held in memory and rebroadcast to everyone, so an unbounded message is
  everyone's problem rather than the sender's.
- The webview runs under `default-src 'none'` with a nonced script and renders
  all agent text escape-first.

### The container's command allowlist is a trust decision, not a sandbox

`RIPIENO_ALLOWED_COMMANDS` is empty by default and a container with no allowlist runs
nothing. If you set one, understand what you are choosing.

An agent can write project files. So allowlisting `npm test` means an agent can
write a `package.json` whose test script is anything at all, and then legitimately
ask for `npm test`. The escape is through the allowed program's own
configuration, not through the command string, so no amount of blocking shell
metacharacters changes it.

**Allowlisting a build tool means trusting everyone in the room with code
execution in that container.** Often a reasonable choice; not one to make by
accident. What the container does instead is make the prize small: `RIPIENO_*`
variables are stripped from every command's environment in both hosts, and in the
container provider keys and anything ending in `TOKEN`, `SECRET` or `PASSWORD` go
too — nobody is watching there, and the room could simply ask an agent to run
`env`. On a member's own machine they are kept: a human approved that command,
and stripping their environment would break ordinary work to prevent something
they were present for.

## Tests

```bash
npm test          # 348 across five packages, ~1 minute
npm run typecheck
```

The rules that are expensive to get wrong are pure functions with no I/O —
`roomCore.ts` (provenance envelope, addressing, event dedupe, the idle gate),
`protocol/describeMembers` (what an agent is told about who is in the room) and
`workspace-core/paths.ts` (the confinement boundary) — so they are tested without
a socket or a credential.

What that misses is everything the pieces do *together*, which is where the bugs
two real users hit actually lived. So `extension/test/agentHost.test.js` starts a
relay, attaches real agent hosts to it, and puts a script in place of the model
that writes down the prompt it was given. It is the only way to assert that an
agent was told who is in the room — and it immediately found that selecting a
CLI provider had been quietly running Claude Code instead.

## Not done, on purpose

- **The container is not deployed.** It is built and tested; deploying it is
  infrastructure work that produces nothing a reader can see.
- **Nothing is published to a marketplace.** Build the `.vsix` and install it.
- **Hosted mode is on a branch**, because it has never run against a live session.
- **Agents stop talking to each other quickly.** One may name another and get an
  answer — report, check, respond — and then it stops until a person speaks. The
  relay counts, per agent, how many times that agent has spoken since a human
  last did; nothing in a message influences the number, so with N agents the
  worst case is 2N messages whatever they say to each other.
