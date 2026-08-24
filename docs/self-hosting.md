# Running your own relay

**There is no shared service in this Preview.** A room lives on infrastructure
you control: your laptop, or a server you deployed. That is a deliberate current
product boundary, not a hidden dependency — see
[Why there is no hosted option](#why-there-is-no-hosted-option).

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
RIPIENO_HOST=0.0.0.0 RIPIENO_DATA_DIR=./data npm start
```

Or without a toolchain at all, which is the shorter path on any machine that
runs containers:

```bash
docker build -t ripieno-relay .
docker run -p 8787:8787 -v ripieno-data:/data ripieno-relay
```

Either way it prints what you need on startup and there is no token to mint:

```
  Ripieno relay ready

    URL     wss://relay.example.com
    Token   0123456789abcdef0123456789abcdef0123456789abcdef  (generated, saved)
    Room    general
    Members verified against GitHub
```

A token is generated on first boot and written to `RIPIENO_DATA_DIR/relay-token`
so it survives restarts — without a data directory it is regenerated each time,
which silently invalidates every invite link already sent. Set `RIPIENO_TOKEN`
yourself and nothing is generated or written.

It listens on `8787` by default. For other people to reach it they need a route
to that port. Ripieno clients require encrypted `wss://` transport away from
loopback, so terminate TLS in front of the relay or use an SSH tunnel that maps
the remote port to loopback. A private Tailscale/WireGuard network still needs
TLS unless each member uses a loopback tunnel.

Give the URL and token to the people joining, or — easier — join the room
yourself and use **Copy Invite Link** in the extension, which packages the URL,
the room and the token into a single link. The relay deliberately does not print
that link itself: its URI scheme belongs to the editor, and Cursor, Antigravity
and VS Code each register their own.

### How it knows its own address

A relay behind a proxy cannot see the name it is reached by, so it reads the one
the proxy sends — `X-Forwarded-Host` and `X-Forwarded-Proto` on the first request
that arrives. That works identically behind Railway, Fly, Render, nginx, Caddy or
a `cloudflared`/`ngrok` tunnel, with nothing to configure.

`RAILWAY_PUBLIC_DOMAIN`, `RENDER_EXTERNAL_URL`, `KOYEB_PUBLIC_DOMAIN` and
`FLY_APP_NAME` are read too, only as a shortcut that saves waiting for the first
request. Set `RIPIENO_PUBLIC_URL` to override everything. If the printed address
says `(guessed)`, nothing had told it yet.

## 3. Deployed, so the room outlives your laptop

Any host that runs a Node process and can give it a persistent disk. Railway is
what this was developed against; Fly, Render, a VPS or a container platform all
work the same way.

```bash
# Railway, from a clone of this repo
railway init
railway volume add --mount-path /data
railway variables --set "RIPIENO_DATA_DIR=/data"
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
| `RIPIENO_TOKEN` | generated | Shared secret required to join. Generated on first boot and saved to the data directory if you do not set one; embedded solo mode needs none. |
| `RIPIENO_PUBLIC_URL` | learned from the proxy | The address to hand out. Only needed when the printed one is wrong. |
| `RIPIENO_DATA_DIR` | none | Where room history is written. Without it, a restart empties every room. Point it at a mounted volume. |
| `RIPIENO_REQUIRE_GITHUB` | on for the standalone relay | Verify members against GitHub rather than believing the handle they send. Set `0` to turn it off — see below. |
| `RIPIENO_WORKSPACE_TOKEN` | none | Separate secret for the shared-workspace container. Without it the workspace role is refused entirely. |
| `RIPIENO_PORT` / `PORT` | 8787 | `PORT` wins, so most hosts need no configuration. |
| `RIPIENO_HOST` | `127.0.0.1` locally; `0.0.0.0` when `PORT` is injected | Interface to bind. Setting any non-loopback host also requires `RIPIENO_TOKEN`. |

### The token is a gate, not a login

A holder of `RIPIENO_TOKEN` can reach the relay. It does **not** establish who they
are: without identity verification, a token holder can claim any handle,
including yours, and the attribution the room displays is then a convention
rather than a fact.

The standalone relay keeps `RIPIENO_REQUIRE_GITHUB` **on by default**, even if
it binds to loopback behind a reverse proxy. Members sign in with GitHub, the relay asks GitHub who the token
belongs to, and the handle in the transcript is the one GitHub returned. If
GitHub cannot be reached, joins are refused rather than trusted — "cannot check"
is the state the feature exists to replace.

Turn it off with `RIPIENO_REQUIRE_GITHUB=0` if the relay is on a private network
where the token is already the boundary. That is a reasonable choice; it is not
a default, because a default that quietly weakens the product's central claim is
worse than not making the claim.

The extension's embedded solo relay skips both the shared token and GitHub
verification. A standalone loopback relay is different: a proxy or tunnel can
make it externally reachable, so it retains the secure standalone defaults.

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
