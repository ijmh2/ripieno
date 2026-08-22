# Support

Ripieno is a Preview, free for personal and internal use. Support is
best-effort through
[GitHub Issues](https://github.com/ijmh2/ripieno/issues).

Before filing an issue:

1. Use the latest commit or published Preview build.
2. Run `npm test` and `npm run typecheck` when reporting a source-build problem.
3. Check the **Ripieno** output channel in the editor.
4. For connection problems, confirm the relay uses `wss://`, has
   `RIPIENO_TOKEN`, and has persistent storage if history must survive restarts.
5. For a local ChatGPT agent, confirm `codex login status` succeeds in the same
   environment that launches the editor.

Include the Ripieno version/commit, editor and version, OS, provider type,
expected behavior, actual behavior, and minimal reproduction. Remove room
tokens, GitHub tokens, API keys, file contents and private URLs from logs and
screenshots.

Follow [SECURITY.md](SECURITY.md) for security issues; use GitHub private
vulnerability reporting when that repository feature is enabled, and never put
sensitive details in a public issue. Feature requests and compatibility reports
for VS Code forks may use ordinary issues; invite URI schemes and extension
installation paths vary between forks.
