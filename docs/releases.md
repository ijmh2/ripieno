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

## Publish

Commit the version and changelog before producing the release artifact. Attach
the versioned VSIX and checksum to the matching GitHub release when publishing
is authorized. Keep installation, GitHub release publication and Marketplace
publication separate so a local preview is not mistaken for a public release.
