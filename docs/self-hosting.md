# Running your own relay

**There is no shared service.** Nobody is hosting a relay for you, and this
project will never point you at one. A room lives on infrastructure you control:
your laptop, or a server you deployed. That is a deliberate design decision, not
a missing feature — see [Why there is no hosted option](#why-there-is-no-hosted-option).

Three ways to run one, in increasing order of effort.

## 1. No relay at all

Leave `ripieno.relayUrl` empty. The extension starts a relay inside your editor,
bound to loopback, on a port the OS picks. Nothing is deployed, nothing is
exposed, no token, no account.

This is the *same* relay a team shares — same rooms, same attributed transcript,
same tool routing, same action log, same persistence. Not a reduced imitation.

Use it to try the product, and to work with several of your own agents at once.
It cannot be joined by anybody else, because nothing outside your machine can
reach loopback.

## 2. On a machine you already have

Anywhere Node 20+ runs:

```bash
git clone <this repo> && cd <this repo>
npm ci
RIPIENO_TOKEN=$(openssl rand -hex 24) RIPIENO_DATA_DIR=./data npm start
```

It listens on `8787` by default. For other people to reach it they need a route
to that port — a LAN address, a Tailscale/WireGuard address, or an SSH tunnel. A
private network is a perfectly good answer here and avoids exposing anything to
the internet.

Print the token once and give it to the people joining, alongside the URL. Or
use **Copy Invite Link** in the extension, which packages the URL, the room and
the token into a single link.

## 3. Deployed, so the room outlives your laptop

Any host that runs a Node process and can give it a persistent disk. Railway is
what this was developed against; Fly, Render, a VPS or a container platform all
work the same way.

```bash
# Railway, from a clone of this repo
railway init
railway volume add --mount-path /data
railway variables --set "RIPIENO_TOKEN=$(openssl rand -hex 24)" --set "RIPIENO_DATA_DIR=/data"
railway up
```

`railway.json` in the repo root already sets the build command, start command
and healthcheck, so there is nothing else to configure.

Expect a few dollars a month for the smallest instance. A relay is a router: it
holds a transcript in memory, forwards frames, and does no model inference — CPU
is negligible and memory is bounded by design (500 entries and 32k characters per
message, per room).

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `RIPIENO_TOKEN` | none | Shared secret required to join. **Mandatory** when `PORT` is set — the relay refuses to start on a deployment without one. |
| `RIPIENO_DATA_DIR` | none | Where room history is written. Without it, a restart empties every room. Point it at a mounted volume. |
| `RIPIENO_REQUIRE_GITHUB` | on, unless loopback | Verify members against GitHub rather than believing the handle they send. Set `0` to turn it off — see below. |
| `RIPIENO_WORKSPACE_TOKEN` | none | Separate secret for the shared-workspace container. Without it the workspace role is refused entirely. |
| `RIPIENO_PORT` / `PORT` | 8787 | `PORT` wins, so most hosts need no configuration. |
| `RIPIENO_HOST` | `0.0.0.0` when `PORT` is set | Interface to bind. |

### The token is a gate, not a login

A holder of `RIPIENO_TOKEN` can reach the relay. It does **not** establish who they
are: without identity verification, a token holder can claim any handle,
including yours, and the attribution the room displays is then a convention
rather than a fact.

So on any relay another machine can reach, `RIPIENO_REQUIRE_GITHUB` is **on by
default**. Members sign in with GitHub, the relay asks GitHub who the token
belongs to, and the handle in the transcript is the one GitHub returned. If
GitHub cannot be reached, joins are refused rather than trusted — "cannot check"
is the state the feature exists to replace.

Turn it off with `RIPIENO_REQUIRE_GITHUB=0` if the relay is on a private network
where the token is already the boundary. That is a reasonable choice; it is not
a default, because a default that quietly weakens the product's central claim is
worse than not making the claim.

Loopback relays skip it. There is nobody else on loopback, and demanding a
GitHub sign-in to talk to your own laptop is ceremony rather than security.

## Why there is no hosted option

Two reasons, one principled and one practical.

**The principled one:** a relay sees every message in every room and routes every
tool call. Running one for other people means holding their conversations and
standing between their agents and their filesystems. The product's argument is
that provenance should be verifiable rather than taken on trust, and asking you
to trust an unaudited third-party server with all of it would contradict that on
the first page.

**The practical one:** whoever runs a relay pays for it. A hosted option means
either a bill or a business, and this is neither. Running your own costs a few
pounds a month, or nothing at all if you use your own machine.

If you deploy one and share the URL, remember that everyone you give the token to
can join every room on it. One relay per group of people who already trust each
other; a separate relay, or at least a separate token, for anyone else.
