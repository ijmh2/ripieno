# Privacy and data flow

Ripieno has no telemetry and this project operates no hosted service. Data does
leave the editor when you choose a model provider or join a relay. The operator
of each relay or provider controls its own logging, retention and privacy terms.

## Stored by the editor

VS Code global state stores the last room and relay, agent labels, briefs,
working-directory paths, provider/model choices, custom executable arguments,
permissions and resumable provider session IDs. VS Code SecretStorage stores
OpenAI-compatible API keys and invite-provided room tokens; room tokens are
keyed to a normalized relay so one relay cannot receive another relay's token.
For compatibility, `ripieno.roomToken` may still hold a token in plaintext
editor configuration. When Ripieno migrates that value to SecretStorage it
does not clear the setting automatically; clear it yourself after migration.

Provider credentials owned by a local CLI remain with that CLI. Ripieno does
not copy ChatGPT, Claude or Gemini login credentials into its own settings.
Local Claude, Codex, Gemini and custom CLI processes inherit the extension
host's process environment unless that CLI removes variables itself; do not
launch the editor with unrelated secrets in its environment. Standing tool
approvals are held in memory for the current extension-host session and are not
persisted.

## Sent over the network

- Room messages, roster data, actions, usage reports, room tokens and tool
  routing frames go to the selected relay. Every joined room client receives
  the bounded transcript, roster, action summaries and usage totals. Full tool
  requests are routed only to the selected workspace host and their results
  only to the requesting agent. Remote relay transport must be `wss://`;
  loopback development may use `ws://`.
- When a relay verifies identity, the editor sends it a GitHub `read:user`
  token and retains it in memory for the extension-host session so reconnects
  can be authenticated. The relay sends the token to GitHub, caches only a
  token hash and the returned public profile for at most ten minutes, and does
  not persist the raw token.
- OpenAI-compatible prompts, room context and API keys go directly to the
  configured endpoint. Remote endpoints must use `https://`; loopback endpoints
  may use `http://`.
- Local CLI providers receive prompts and room context through their local
  process. Any network use after that is controlled by the provider's CLI.

## Relay history and limits

The live relay keeps at most 500 transcript entries and 200 actions per room;
individual messages are capped at 32,000 characters. If `RIPIENO_DATA_DIR` is
configured, the relay writes plaintext JSON snapshots containing transcript,
actions, roster/roles, usage, goals, shared context, handoffs and their bounded
mutation histories. Persisted history keeps up to 500 transcript entries within
an approximately 1,000,000-character serialized transcript budget, plus up to
200 actions. That budget applies only to the transcript, not the whole snapshot
or its UTF-8 byte size. Other state is stored alongside it under separate limits.
There is no retention timer or purge UI in this Preview. Old entries may be
dropped or truncated; history is an editable operational record, not a complete
or tamper-evident audit trail.

Solo mode writes the same plaintext room snapshots under the extension's VS
Code global-storage directory so history survives an editor reload. Without a
relay data directory, a remote relay's history disappears when that process
restarts.

## Operator backup and review

For a stable backup, ask members to leave and stop the relay cleanly, then copy
the files in its configured `RIPIENO_DATA_DIR` to a private location. Room JSON
filenames are derived from the room code, and snapshots can contain code,
prompts, names and private project context. Solo snapshots live under the
extension's global-storage directory. This is an operator backup procedure;
there is no member-facing export command yet.

Before sharing evidence for a change, select and inspect only the relevant
decisions and actions, and attach the Git commit/diff and actual verification
results. An agent saying a test passed is a reported result, not independent
verification. A backup does not restore entries already discarded by limits
and does not make the history immutable. Anyone with a copy controls its
retention, separately from the running relay.

## Deletion

- Delete an agent from **Rooms & Agents** to remove its saved configuration,
  resumable session reference and Ripieno-managed API key.
- Stop the relay and delete only that relay's configured `RIPIENO_DATA_DIR` to
  remove its persisted room history. This cannot be undone.
- Removing the extension does not guarantee the editor or operating system
  immediately removes global state and SecretStorage. For complete local
  cleanup, remove the `ijmh2.ripieno` extension data using your editor's user
  data controls and the corresponding SecretStorage entries in the OS credential
  store. Back up anything you need first.
- Ask model, relay and GitHub operators separately about copies retained in
  their logs or systems; Ripieno cannot delete data held by another service.

Security reporting is covered by [SECURITY.md](SECURITY.md).
