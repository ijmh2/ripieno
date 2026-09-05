# Ripieno — shared rooms for people and AI agents

Ripieno adds a shared room to VS Code and compatible forks. Several people can
bring their own local or API-backed agents into one attributed conversation and
route workspace work through explicit host-side boundaries.

This is a **0.0.x Preview**, free for personal and non-commercial use. It runs locally
or against a relay you operate; the project does not provide a hosted relay.

## Quick start

1. Open a project folder in Antigravity, VS Code or a compatible editor.
2. Open **Ripieno** in the Activity Bar and choose **Start a room for yourself**.
   With no relay configured, Ripieno starts a local solo relay automatically.
   Choose **Join a room** instead when you have a room invitation.
3. Choose **Add agent…**, or attach an existing agent from **Rooms & Agents**.
   Follow the provider setup prompts to install or sign in if needed.
4. Give the agent a small first task in **Chat**. If it responds only when named,
   mention it using `@`.
5. Choose **Open workspace** for the full conversation. Open **Tasks**, **Brain**,
   **Agents**, **Review** or **Browser** in the optional details pane. Close the
   pane to return to an uncluttered conversation. The Command Palette entry
   **Ripieno: Open Full Room Panel** remains available.

For code-anchored comments and shared file tools, host your open project through
**Ripieno: Host / Release the Shared Workspace**. Attaching an agent or assigning
a task does not grant new file permissions or automatically run that task.

Agents start with a generated name, an empty optional brief, provider-default
model and the safest usable concrete boundary: Conversation only, Read project,
Ask before changes, or provider-managed where Ripieno cannot enforce one. Use
the gear afterward to edit name, brief, model, response mode, workspace folder
and permissions individually, or to delete the agent after confirmation.

A ChatGPT web conversation cannot be imported. Install Codex CLI and run
`codex login` to sign in with ChatGPT, or use an API key. API-key usage is billed
separately through the OpenAI Platform. See
[OpenAI's authentication guide](https://learn.chatgpt.com/docs/auth).

## Install or update a Preview

Run **Extensions: Install from VSIX…** and select the versioned Ripieno package.
Then run **Developer: Reload Window**. The extension details page shows the
installed version. Reopen Ripieno and start or join your room if disconnected.

## Plans, tasks and Brain

Create shared plans, assign people and update step progress in the workspace.
Dependencies must finish before their dependent step can start. Work claims
announce current intentions and warn about overlapping shared files; they are
not file locks.

Select code in the hosted project and choose **Add Shared Code Comment** or
**Remember Selection in Brain** from the editor context menu. An anchor opens
only while the host and file content still match. Changed code needs a fresh
anchor; Ripieno does not guess which lines replaced it.

Agent-proposed memories remain proposed until a person accepts them. Search
shared records by title, body, tags or owner. Handoff recovery offers explicit
recipient actions when work is interrupted; uncertain execution is never
silently retried.

## Let an agent use a browser

Ask an attached Codex or Claude agent to open a URL in its Ripieno browser. The
first request asks you to enable browser control. Open **Browser** in the full
workspace to see page captures and interact alongside the agent. Google Chrome
must be installed on the machine running the extension. This is a separate,
temporary profile with no existing browser logins.

Use **Stop** to close the session and revoke control. Disconnecting or detaching
also closes it. Only one agent at a time uses this editor's browser. API agents
with function calling can inspect and interact too; CLI Gemini is not connected
to the browser tools in this preview. See the
[redesign notes](https://github.com/ijmh2/ripieno/blob/main/docs/workspace-redesign.md)
for current capabilities and verification limits.

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
— free for personal and non-commercial use, licensed for organisations. Not open
source. Bundled dependency
notices are in
[THIRD_PARTY_NOTICES.md](https://github.com/ijmh2/ripieno/blob/main/packages/extension/THIRD_PARTY_NOTICES.md).
