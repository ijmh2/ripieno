# Architecture

How a message moves through the system, and which file owns which decision. The
[README](../README.md) covers what the product is; this is the code-level map.

## Layers

`protocol` carries plain JSON over a WebSocket and no vendor types
([`index.ts`](../packages/protocol/src/index.ts)); `relay` and `extension` both
depend on it, and nothing depends on them. Inside the relay:

| File | Owns |
|---|---|
| [`server.ts`](../packages/relay/src/server.ts) | Sockets, room registry, join auth, liveness |
| [`room.ts`](../packages/relay/src/room.ts) | Membership, transcript, presence, fan-out |
| [`roomCore.ts`](../packages/relay/src/roomCore.ts) | Pure logic: provenance, roster prompt, addressing, dedupe, idle gate |
| [`driver.ts`](../packages/relay/src/driver.ts) | The boundary an agent implementation must satisfy |
| [`hostedDriver.ts`](../packages/relay/src/hostedDriver.ts) / [`byoDriver.ts`](../packages/relay/src/byoDriver.ts) | One shared CMA session / no-op, members bring their own |

`roomCore.ts` is I/O-free on purpose — every rule that is expensive to get wrong
is a plain function, testable without a socket or a credential.

## A member speaks

```
{t:"say"} ▶ server.ts ▶ Room.say() ▶ transcript + {t:"entry"} broadcast
                                   ▶ driver.say() ▶ envelope() ▶ session
```

`envelope()` wraps text in `<message from="@handle">` and neutralises any
`</message>` in the body, so a member cannot close the tag early and have the
model attribute their words to someone else ([`roomCore.ts:26`](../packages/relay/src/roomCore.ts)).
`server.ts:135` chains inbound frames onto one promise queue — without it, a
client flushing a queued tool result in the same tick as its `join` loses it.

## The agent uses someone's workspace

```
session event ▶ resolveTarget(roster, handle) ─not ok─▶ errored result + a reason
                                              └──ok──▶ {t:"toolCall"} to that socket only
{t:"toolProgress"} ▶ extends the deadline    {t:"toolResult"} ▶ driver.resolveToolCall()
```

Two guards, easily conflated:

- **Addressing** ([`roomCore.ts:113`](../packages/relay/src/roomCore.ts)) — the
  agent picks the handle, since `agent.custom_tool_use` identifies no member.
  Unknown, missing and offline handles return a corrective *reason*, so the
  agent retries correctly instead of repeating itself.
- **Answering** ([`room.ts:227`](../packages/relay/src/room.ts)) — only the
  addressed member may answer. Authentication alone would not fix this: an
  authenticated member could still forge another's private workspace into the
  shared context.

Timeouts are state-aware (`received | awaiting-approval | running`), so a human
reading a confirmation dialog is not racing a fixed timer.

## Identity, and modes

A handle can hold several live connections — one editor plus that person's own
agents, keyed by owner-namespaced id (`server.ts:175`) so neither one person's
two agents nor two members' default ids evict each other. Disconnects pass the
*socket*, not the handle (`room.ts:137`): a reconnect installs its replacement
before the stale close fires.

`Room` takes a `RoomDriver`, never a concrete driver, so BYO (default, no
Anthropic client constructed) and hosted (one shared session, key only in the
relay) differ only in what `createRoom()` builds (`server.ts:71`). The mode ships
in `JoinedMsg` so a room is never ambiguous about which it runs.

`packages/relay/test/` covers where these break: the envelope including the
impersonation attempt, dedupe across reconnects, the `status_idle` gate, tool
addressing failures, tool windows, and fan-out through a fake driver.
