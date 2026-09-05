# Ripieno workspace redesign — 0.0.3 Preview

The workspace now puts the actual room conversation and composer in the centre.
Tasks, Brain, agent details, review and browser open in an optional right pane.
The welcome screen offers one primary resume/start action. Counters and disabled
forms no longer occupy the disconnected screen. Shared file coordination and
folder details remain available through disclosures.

The compact sidebar still works. The full workspace reuses its message parser,
chat markup and renderer, with snapshots and live deltas delivered to both.
An approval resolved in one surface is removed from the other. Losing both
visible surfaces declines pending approvals rather than silently allowing them.

## Agent browser

Codex receives a per-process MCP configuration with only the seven browser
tools enabled. Claude uses the existing authenticated workspace MCP bridge.
OpenAI-compatible agents receive browser function tools alongside context tools.
Gemini's CLI is not wired to these browser tools in this preview.

The first browser request asks the owner to enable control. A single agent at a
time can own this editor's browser. The browser uses Chrome's DevTools protocol
over inherited process pipes; it does not expose a debugging network port.
Chrome starts headless with a separate temporary profile. The right pane shows
real 1280×800 page screenshots and updates after actions or manual refresh.
This is a screenshot-driven browser view, not continuous video or an iframe.

Tools can open HTTP/HTTPS URLs, read page text and visible element coordinates,
click, type, press supported keys, scroll, capture a screenshot and close the
session. The owner can navigate and interact in the pane too. Local files,
executable URLs, embedded URL credentials and downloads are excluded. The
browser does not inherit the user's existing tabs, cookies or saved logins.

Browser observations go to the requesting agent and the owner's extension UI.
They are not automatically broadcast as screenshots or page text to the room;
an agent can still include relevant browser findings in its shared reply.
Browser page content is untrusted input, not additional task authority.

Stop revokes the current browser session. Disconnect, agent detachment and
extension disposal terminate the browser. Reattach an agent to request a new
session after access was stopped or declined. Closing the details pane merely
hides it; use Stop to end browser control.

## Evidence and remaining limits

- TypeScript and JavaScript syntax checks passed.
- Existing focused room UI tests passed after changed label assertions.
- Browser boundary checks cover session identity, bounds, unsupported actions,
  and Stop while busy.
- A real isolated Chrome process navigated a local test page, returned text and
  PNG, clicked and typed successfully, refused a file URL, and stopped.
- A real MCP client received browser tools and image content through the local
  authenticated bridge. Installed Codex parsed the scoped MCP configuration.
- Static screenshots use the real workspace renderer with illustrative room
  data. They are not evidence of a live multi-person or provider conversation.

The complete agent-to-browser flow still needs manual acceptance in Antigravity
with the user's provider. No live Codex or Claude model turn was run for this
milestone. Popup/new-tab management, file uploads, downloads and persistent
browser logins are not part of this first browser implementation. The local
browser path has been exercised on macOS; other desktop paths need acceptance.
