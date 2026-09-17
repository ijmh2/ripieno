# Security policy

Ripieno is currently a **0.0.x Preview**. When public builds exist, only the
latest published Preview is supported; older builds should be upgraded before
a report is investigated. Source installs and privately shared VSIX files must
identify the exact commit they were built from.

## Report a vulnerability privately

If the repository exposes
[GitHub private vulnerability reporting](https://github.com/ijmh2/ripieno/security/advisories/new),
use it. Do not put tokens, API keys, private room content, exploit details or
private repository contents in a public issue. If private reporting is
unavailable, open a minimal
[security issue](https://github.com/ijmh2/ripieno/issues/new) that contains no
sensitive detail and asks for a private contact route.

Include the Ripieno version or commit, editor and OS, affected configuration,
reproduction steps, impact, and whether the issue is already being exploited.
Please wait for a fix before publishing exploit details.

## Security boundaries

- A relay can read room messages and route tool calls. Use a relay you trust.
- Remote relays must use `wss://`; remote OpenAI-compatible endpoints must use
  `https://`. Plaintext transport is accepted only on loopback.
- `RIPIENO_TOKEN` is a shared gate, not an identity. The standalone relay
  requires it and verifies GitHub identity by default, even when it binds to
  loopback behind a reverse proxy. Explicitly disabling identity verification
  makes displayed authorship self-asserted.
- The default relay is one trusted group: a verified token holder can join any
  known room. Room codes and owner/member/viewer roles are not admission gates.
  Operators can enable `RIPIENO_ROOM_POLICY_FILE` for per-room GitHub allowlists.
  This mode requires verified identity, denies unknown rooms, and checks humans
  and agents before loading or sending room state. It refuses shared-workspace
  container connections because the global workspace token is not room-scoped.
  Policy changes require a relay restart to disconnect and recheck participants;
  allowlists use case-insensitive GitHub logins, which operators must maintain
  when accounts are renamed or removed.
- A verified relay receives a `read:user` GitHub token and asks GitHub for the
  corresponding account. The editor holds the token for its extension-host
  session; the relay does not persist the raw token and caches only its hash and
  public profile for up to ten minutes.
- Local agents run with their configured provider permissions. Before a
  workspace-capable agent joins a shared room, Ripieno warns that room members
  can influence it. Approval prompts and sandbox settings remain meaningful
  security controls.
- Ripieno does not support untrusted or virtual workspaces in this Preview.
- Shared file proposals carry their original content. Cooperating write gates
  reject proposals whose baseline changed while they were prepared or awaiting
  approval, and editor writes also reject unsaved buffers. After a conflict,
  read the current file and prepare a fresh edit. This is not an operating-system
  lock against shell commands, external editors or other processes. A
  `write_file` replacement snapshots its baseline when the tool is invoked; it
  cannot detect that an agent generated that replacement from an earlier read.
  Prefer `edit_file` with current, specific matching text for incremental work.
- A shared-workspace container is built and tested but not deployed or shipped
  as a hosted service.

Deployment guidance is in [docs/self-hosting.md](docs/self-hosting.md), data
handling is documented in [PRIVACY.md](PRIVACY.md), and bundled licenses are in
[packages/extension/THIRD_PARTY_NOTICES.md](packages/extension/THIRD_PARTY_NOTICES.md).
