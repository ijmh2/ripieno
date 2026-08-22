# Ripieno — shared rooms for people and AI agents

Ripieno adds a shared room to VS Code and compatible forks. Several people can
bring their own local or API-backed agents into one attributed conversation and
route workspace work through explicit host-side boundaries.

This is a **0.0.x Preview**, free for personal and internal use. It runs locally
or against a relay you operate; the project does not provide a hosted relay.

## Quick start

1. Open a trusted, filesystem-backed workspace.
2. Open **Ripieno** in the Activity Bar and choose **Join a room**. With no relay
   configured, Ripieno starts a loopback-only solo relay automatically.
3. Follow the three compact steps in Room. If a configured agent exists, attach
   it; otherwise choose **Add agent…**. A detected provider appears first;
   ChatGPT / Codex, Claude Code, Gemini CLI and OpenAI-compatible endpoints are
   supported.
4. Type in the Room view. Type `/` for local room commands such as `/model`,
   `/agents`, `/attach` and `/detach`.

Agents start with a generated name, an empty optional brief, provider-default
model and the safest usable concrete boundary: Conversation only, Read project,
Ask before changes, or provider-managed where Ripieno cannot enforce one. Use
the gear afterward to edit name, brief, model, response mode, workspace folder
and permissions individually, or to delete the agent after confirmation.

A ChatGPT web conversation cannot be imported. Install Codex CLI and run
`codex login` to sign in with ChatGPT, or use an API key. API-key usage is billed
separately through the OpenAI Platform. See
[OpenAI's authentication guide](https://learn.chatgpt.com/docs/auth).

## Work with other people

Deploy the relay from the repository using the
[self-hosting guide](https://github.com/ijmh2/ripieno/blob/main/docs/self-hosting.md),
terminate TLS, and configure its `wss://` URL. Join a room, then choose **Copy
Invite Link**. Invite links can contain the shared room token and must be treated
like passwords.

Before a workspace-capable local agent attaches to a shared room, Ripieno warns
that everyone in that room can influence it. The agent's own permission choice
still decides whether it is read-only, workspace-limited, approval-gated or has
full local access.

## Data and trust boundaries

- The relay sees room messages and routes tool calls. Use one you trust.
- Remote relay connections require `wss://`; remote API endpoints require
  `https://`. Plaintext transport is accepted only on loopback.
- Invite-provided room tokens and API keys use VS Code SecretStorage. The
  legacy `ripieno.roomToken` setting remains supported for compatibility and
  is plaintext editor configuration; migrate it to an invite and clear it.
  Provider CLI credentials remain owned by the provider CLI.
- Member-hosted remote writes and commands show an approval in that member's
  editor. The optional unattended workspace container uses its configured
  allowlist instead of a human prompt.
- Ripieno declares untrusted and virtual workspaces unsupported in this Preview.

Read the full [security policy](https://github.com/ijmh2/ripieno/blob/main/SECURITY.md)
and [privacy/data-flow disclosure](https://github.com/ijmh2/ripieno/blob/main/PRIVACY.md)
before using a shared room.

## Important settings

| Setting | Purpose |
|---|---|
| `ripieno.relayUrl` | Empty for solo mode, or the `wss://` address of your relay. |
| `ripieno.roomToken` | Legacy/configuration fallback for the relay gate. Invite tokens are stored in SecretStorage instead. |
| `ripieno.commandApproval` | Whether member-hosted shell commands always ask, use an allowlist, or run without a prompt. |
| `ripieno.allowedCommands` | Prefixes allowed without prompting when command approval uses the allowlist. |

Most agent configuration is adjusted from the gear beside that agent rather
than through settings JSON.

## MCP and compatibility

An MCP-capable agent can join using the
[MCP guide](https://github.com/ijmh2/ripieno/blob/main/docs/mcp.md). VS Code forks
may use different invite URI schemes and extension-installation paths; report a
fork-specific issue with its name and version.

## Preview limitations

- Distribution listings and repository releases are the authoritative source
  for whether a particular Preview build has been published.
- The shared-workspace container is built and tested but not deployed by this
  project.
- Hosted-agent mode is not shipped.
- Room history has bounded retention and no purge UI yet.

For help, see [SUPPORT.md](https://github.com/ijmh2/ripieno/blob/main/SUPPORT.md).
Follow the security policy for private reporting when available; never include
sensitive details in a public issue.

Source-available under the [alpha terms](https://github.com/ijmh2/ripieno/blob/main/packages/extension/LICENSE)
— free for personal and internal use, not open source. Bundled dependency
notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/ijmh2/ripieno/blob/main/packages/extension/THIRD_PARTY_NOTICES.md).
