# Ripieno preview releases

Every user-facing build gets a distinct extension version. Update
`packages/extension/package.json`, its entry in `package-lock.json`, and
`packages/extension/CHANGELOG.md` together. Keep the Preview designation until
the complete collaboration experience has been verified with real users.

## Build an installable package

From the repository root, run `npm ci`, then `npm run package`. The resulting
`dist/ripieno-<version>.vsix` includes the bundled extension and embedded relay.
Builds do not publish or install the extension automatically.

The **Build audited Preview VSIX** GitHub Actions workflow can be started
manually for a chosen commit. It checks types, dependencies and tests, builds
the package, runs the extension-host smoke check and saves the VSIX with its
SHA-256 checksum. Download those files from the workflow's artifact. A
successful workflow is evidence for that exact commit, not later edits.

## Try a preview in an editor

1. Run **Extensions: Install from VSIX…** and select the package.
2. Run **Developer: Reload Window**.
3. Check Ripieno's installed version in the Extensions view.
4. Open a project, start or join a room and attach an agent.

For each release, record the editor and provider versions actually exercised.
The manual acceptance flow is: join with two people, attach their agents,
assign work, review an attributed change, then reload and resume. Include
disconnect and declined-approval behavior. Do not describe a browser fixture or
mocked extension API as a completed two-editor check.

Shared deployments also need the matching relay build. An updated extension
can read legacy context from an older relay, but plans and claims require the
corresponding relay capabilities.

## Acceptance record

Copy this checklist into the release notes and fill in the evidence. Leave
unperformed checks marked **not run**. Do not publish a build as verified by
reusing results from a different commit or a mocked provider.

| Check | Required evidence |
|---|---|
| Build identity | Commit SHA, extension version, VSIX SHA-256, relay version, CI run link |
| Supported environment | OS, editor version, provider CLI/API and version for each participant |
| Fresh setup | Install on a clean Windows machine and a supported Unix machine; open the packaged extension and start a solo room |
| Team activation | Two accounts on separate machines join, attach agents and complete one shared task; record setup time and failures |
| Access boundary | Allowed accounts join their configured room; another verified account and an unknown room are denied without receiving history |
| Stale file proposal | Two proposals begin from the same file; after the first is accepted, the stale second is rejected and refreshed without losing the first change |
| Editor approval | Change or dirty the target while approval is open, and create an expected-absent file; both conflicts must preserve current work |
| Declined approval | Reject a write and a command; verify no corresponding file/command side effect |
| Recovery | Disconnect a member, restart the relay with persisted state, rejoin, inspect bounded history and resume an explicit handoff without repeating accepted work |
| Headless host, if offered | Deploy the actual container and verify attributed commits, restart and reconnect; restricted room policies currently reject workspace-role joins |
| Evidence and privacy | Review the relevant diff and recorded test results; remove private prompts, code and credentials from any shared report |

Record the observer, date, result and evidence for each check. Automated smoke
checks cover only their scripted paths; provider authentication, live account
billing and real team behavior still need the manual exercise above.

## Publish

Commit the version and changelog before producing the release artifact. Attach
the versioned VSIX and checksum to the matching GitHub release when publishing
is authorized. Keep installation, GitHub release publication and Marketplace
publication separate so a local preview is not mistaken for a public release.
