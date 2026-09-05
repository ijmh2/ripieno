# Provider activity milestone

Ripieno now enables Codex's structured activity output by default, on top of the
live team board and work claims milestone.

Merged into `main` at `3a05165`, including the existing proposed-diff review
workflow. The combined extension was installed in Antigravity. This document
records the provider milestone; current setup instructions are in the extension README.

## Try it

In VS Code, run **Extensions: Install from VSIX…**, select
`ripieno-provider-activity.vsix`, and reload when prompted. Attach a Codex agent
and open **Ripieno: Open Full Room Panel**. Ask it to read a file and watch the
reported activity. A local provider failure should show the owner an error and
the room an attention summary, without posting the error as a chat reply.

## Behaviour

- New Codex agents run `codex exec --json`, with the room prompt on stdin.
- Existing agents using the exact old stock arguments upgrade at launch. Custom
  commands and customised arguments remain unchanged. Model and permission
  selection still apply separately.
- The board receives observed phases and safe tool summaries. Raw command lines,
  terminal output, provider diagnostics, and reasoning are not shared as activity.
- Codex terminal failures and missing completion events fail the turn even when
  the process exits zero. Interim assistant commentary cannot become a final reply.
- Claude error results, non-zero exits, and incomplete streams also fail instead
  of posting provider errors as chat. Existing streaming and approval routing remain.
- Other room members see `Turn failed; owner attention needed` as the activity
  summary; account details stay with the owner.
- Explicit Codex JSON mode rejects unrecognised output rather than posting raw
  machine data. Custom plain-output configurations retain their fallback.
- CLI pipe decoding preserves Unicode across chunks. Retained stdout/stderr is
  bounded, and early stdin closure cannot crash the extension with EPIPE.

## Evidence and limits

On 5 September 2026, the installed `codex-cli 0.153.1` ran a successful read-only
smoke test in a disposable directory. It read `sample.txt` and returned
`Probe complete.`. Its sanitised capture is
`packages/extension/test/fixtures/codex-0.153.1-readonly.jsonl`; only the thread ID
was replaced. The capture verifies thread, command, assistant, and usage events.
Tests replay it through both the adapter and a real subprocess runner.

Claude regression tests use the existing real 2.1.220 capture. Claude was not
live-tested again during this milestone. Real relay/subprocess tests cover
activity delivery and failed turns staying out of chat.

Codex live token drafts are not inferred from completed assistant messages.
Modern Codex file-change proposals have synthetic coverage only: this read-only
probe did not edit files. A completed file change never becomes a pre-apply review
proposal. A live session with two VS Code editors remains a release check.

Validation: all 732 monorepo tests passed. After the final attention-summary
change, all three affected relay integration cases passed again. The monorepo
typecheck passed, and the extension typecheck passed again after that final
change. The 52 focused adapter/runner tests include Unicode pipe boundaries,
stock-argument migration, terminal failures, and captured provider streams.

## References

- [OpenAI: non-interactive Codex and JSON events](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Anthropic: programmatic Claude Code, streaming and exit behaviour](https://code.claude.com/docs/en/headless)
