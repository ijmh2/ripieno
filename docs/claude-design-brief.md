# Brief for Claude Design — the Ripieno teaser

Paste everything below the line into Claude Design. It is written to be
self-contained: Claude Design cannot see this repository, so every fact it needs
is stated here. Anything not stated, it will invent — which is why the "must not
claim" section is as long as the creative direction.

---

Make a **1080×1920 vertical animation**, about **55 seconds**, that auto-plays
and can be screen-recorded in one take for TikTok. It advertises a developer
tool. Treat this as a piece of motion design, not a slideshow: one continuous
timed sequence with a transport (play / pause / restart) and a **recording view**
that hides every control so a capture is clean.

## 1 · The product, accurately

**Ripieno** — a VS Code extension plus a small self-hosted server ("the relay").
Several people and several AI coding agents work on one codebase at the same
time. Every message and every file change is attributed to a **named actor**: a
specific agent belonging to a specific person, rather than to whoever's machine
happened to run it.

The name: in a concerto grosso, the *ripieno* is the full ensemble, as against
the soloists — several parts sounding together, each still its own line.

### What it actually is, in front of you

Picture a chat panel docked in the sidebar of your code editor, and beside it a
small tree listing who is in the room and which agents belong to whom. You type
a question into the panel. Everyone else in the room sees it, and so does every
agent — each of which belongs to a specific person and runs on that person's own
machine. One agent per member answers. Every line in that panel is colour-coded
by who said it, and an agent's reply is labelled with the agent's name, not its
owner's, so "Sam's reviewer thinks X" is never mistaken for "Sam thinks X".

The part that makes it more than a group chat is what happens when an agent
needs to touch a file. It cannot reach across the network to somebody else's
disk, so the request travels: the agent asks the relay, the relay routes it to
the machine that owns the file, and that person gets a diff to approve before
anything is written. The work happens on their computer, under their
permissions, with their sign-off — and the room's log records which agent asked.

### Why it exists

Every other tool in this space scales **one developer across many agents**. VS
Code, Cursor, Copilot and Claude Code all move that axis. Nobody moved the other
one. The naive way to put a team on an agent is a shared login, and that gives
the agent a single anonymous view of a group of people: it cannot tell agreement
from disagreement, cannot know whose preferences to honour, and has no idea
whose filesystem the next write should land on. Three people behind one session
produce a transcript that reads like one very confused user.

So the fix is that authorship stops being something a client asserts and becomes
structure the server maintains. That is the whole product in a sentence, and the
`git log` shot at the end is the proof: if attribution were decorative, that
column would hold one name.

Facts you may use:

- **Each person brings their own agent**, on their own subscription, on their own
  machine, under their own permissions. Real providers: Claude Code, Codex,
  Gemini, Grok, Kimi, DeepSeek, Ollama, and any OpenAI-compatible endpoint.
- **Self-hosted.** There is no shared service and there never will be. You run a
  relay, or you run solo mode, which needs no relay, no account and no token.
- **The relay maintains authorship as structure** rather than trusting what a
  client claims. On any relay another machine can reach, GitHub verification is
  on by default and the handle shown is the one GitHub returned.
- **Several agents per person is normal** — a coder and a reviewer, say.
- **The payoff**: three agents belonging to three different people write to one
  git repository *concurrently*, and `git log`'s author column holds three
  different names. That column normally holds one — whoever's laptop ran it.

## 2 · What must not be claimed

These are not stylistic preferences. Breaking them makes the video dishonest.

- **Not on any marketplace.** You install a `.vsix` file. Do not imply otherwise.
- **No users, no stars, no downloads, no testimonials, no adoption numbers.**
- **Invent no metrics of any kind** — not speed, not time saved, not percentages.
- **No other companies' logos or brand marks.** Plain text names only.
- **There is no streaming.** The room shows *nothing* while an agent works, then
  the finished answer appears. Never depict live token-by-token typing of an
  agent's reply. If you show the wait at all, show it honestly.

## 3 · The concept

Open on the problem, turn on the product, land on the proof, close on the name.
The emotional shape is: *confusion → recognition → proof → invitation*.

The single most important frame in the whole piece is the `git log` author
column holding three different names. Everything before it is setup; get there
and let it sit.

## 4 · Palette — use these exact values

A committed dark world. **Do not follow the viewer's light/dark theme** — a
frame that changes colour between preview and capture is a bug, not a courtesy.

| Token | Hex | Use |
|---|---|---|
| ground | `#0F1115` | the page |
| raised | `#171A21` | panels sitting on the ground |
| ink | `#E6E3DD` | primary text — warm off-white, never pure white |
| quiet | `#7C808C` | secondary text; a grey biased toward the ground's blue |
| line | `#262A33` | hairlines and borders |
| voice A | `#7EE787` | first actor — this is git's own diff-add green |
| voice B | `#79C0FF` | second actor |
| voice C | `#F0A868` | third actor |

**Colour discipline is the whole design.** The three voice colours mean "this is
a distinct actor" and must never be used decoratively. Everything else is
monochrome. In a 55-second piece, colour should meaningfully change **twice**:
once when the named voices collapse to anonymous grey, once when the author
column lights up. If colour is changing more often than that, it has stopped
carrying meaning.

## 5 · Typography — the rule is the argument

Two faces, and the split is not decorative:

- **Monospace is the machine's voice** — commands, log output, handles, agent
  labels, anything a computer printed. Stack:
  `ui-monospace, "SF Mono", Menlo, "DejaVu Sans Mono", monospace`
- **A humanist sans is a person's voice** — statements, headlines, captions.
  Stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`

Telling those two apart is literally what the product does, so the typography
should embody it rather than be neutral about it.

- **No web fonts.** A strict CSP blocks every external host, and a linked font
  URL will fail silently to a fallback that ruins the layout. System stacks only.
- Sizes are for **a phone held at arm's length**, not a desktop preview: display
  ~104px, statements ~76px, body ~40px, monospace detail ~27–30px. It will look
  oversized in a browser. That is correct.
- Headlines: `font-weight: 600`, `letter-spacing: -0.03em`, `text-wrap: balance`.
- Uppercase labels get `letter-spacing: 0.14em`.

## 6 · Motion — slow, and mostly still

- One easing everywhere: `cubic-bezier(0.16, 1, 0.3, 1)`. Fast departure, long
  settle. **Nothing bounces and nothing springs.**
- Scene transitions: 900ms opacity plus a 26px rise. Element entries: 600–700ms.
- **Let every scene sit still for a beat before the next begins.** Stillness is
  what makes the moving parts read as deliberate rather than busy. If something
  is moving at all times, nothing reads as important.
- Stagger related items by 260–900ms rather than animating them together.
- Honour `prefers-reduced-motion: reduce`.

## 7 · The sequence — exact times and copy

Times are absolute milliseconds from the start. **Drive this from a sorted list
of `{at, fn}` cues against a single clock, not from chained `setTimeout`s** — so
any beat can be retimed by changing one number without disturbing the rest, and
so pause and restart actually work.

**0:00 – 0:05 · The opening.** Black, then two lines. The `n` and `m` are set in
**monospace and voice-A green**; the words are in the sans. They are variables,
and the audience reads them as such.

```
n people.
m agents.
```

> Two different letters, deliberately. `n people, n agents` would assert a 1:1
> ratio, and one person routinely runs several agents. Do not "tidy" this.

**0:05 – 0:13 · Three voices.** Three chat messages, each with a coloured bar, a
monospace handle and the text. Stagger them in 700ms apart.

```
@mellery      ship it, the tests pass
@swhitfield   don't ship it, I'm mid-refactor
@alexr        whose branch are we even on
```

Hold. Then at **0:10.6**, over ~1400ms, **destroy the distinction**: the handles
fade to nothing and all three bars and all three message texts become the same
`quiet` grey. Not a gentle fade-out — the *information* goes. This is the single
best moment available and it should be unhurried.

**0:14 – 0:19 · The problem, stated.**

> # Your agent thinks you're *one person*.
> It can't tell agreement from disagreement. Or whose machine to write the file to.

Set "one person" in voice-A green.

**0:20 – 0:28 · Bring your own.** Two member rows with empty dashed pill-shaped
slots, and below them a tray of agent chips: `Claude Code`, `Codex`, `Gemini`,
`Ollama`. One chip lifts and **arcs** into `@mellery`'s slot; a *different* one
arcs into `@swhitfield`'s. Each takes its owner's colour on landing, and the
dashed target fades out beneath it.

> Different vendors landing on different people is the entire "bring your own"
> idea in one gesture, and it needs no caption.

Headline: **Bring *your own*.** Caption: *Each on its own subscription, running
on its own machine.*

**0:28 – 0:36 · The room.** A panel with roster chips — `@mellery`,
`◆ Mira's coder`, `@swhitfield`, `◆ Sam's reviewer` — staggered in 260ms apart,
then two messages 900ms apart:

```
Sam's reviewer   Read that file from both machines — they differ.
Mira's coder     Mine's stale. Rebasing, then I'll re-run it.
```

Headline: **Everyone brings *their own*.**

**0:37 – 0:51 · The terminal.** A panel in monospace on a slightly darker ground
(`#0B0D11`). A prompt, then the command **types itself** a character at a time at
~52ms per character, with a blinking block caret in voice-A green:

```
git log --pretty='%<(16)%an  %s' -5
```

Pause ~900ms after the last character, hide the caret, then reveal five rows
420ms apart, in two columns:

```
Alex's agent      Mention the limits in the README
Sam's reviewer    Write down both limits
Mira's coder      Bound the transcript
Sam's reviewer    Cover the rate limit
Mira's coder      Add rate limit to relay
```

Then, ~3.6s after the last row lands, **the author column lights up** — the left
column only, each name taking its actor's colour. This is the payoff. Hold it.

Caption underneath: *That column normally holds one name — whoever's laptop ran
the commit.*

> Watching it typed is what makes it read as a terminal rather than a picture of
> one. Do not skip the typing.

**0:52 – 0:55 · Close.**

> # Ripieno
> *In a concerto grosso, the full ensemble — as against the soloists. Several
> parts, each still its own line.*

```
git clone github.com/ijmh2/ripieno
npm run setup
```

Three facts, each prefixed with an em-dash in voice-A green:

```
— free, open source
— self-hosted, nothing in the middle
— solo mode needs no relay at all
```

## 8 · Technical requirements

- **Entirely self-contained.** No external fonts, scripts, stylesheets, images or
  network requests of any kind. Inline CSS and JS, inline SVG, system fonts.
- Fixed **1080×1920**, scaled to fit the preview with a CSS transform on a
  wrapper so the capture geometry stays exact regardless of screen size.
- A **recording view** that hides all controls; `Esc` exits it, space plays,
  `R` restarts.
- Keyboard focus must stay visible on the controls.
- A **seek** capability (e.g. `?t=31000`) is worth building: it is the only way
  to check a late beat without watching the whole thing.

## 9 · Two traps that have already cost real time here

**If you split an animation's X and Y across nested elements** to bend a straight
translate into an arc — which you will need for the drag, since one `transform`
cannot ease its axes independently — then the element carrying the **border and
background must carry both axes**. Putting the visible pill on the outer element
(X only) with the text inside (Y only) makes the outline slide sideways while the
text flies up, leaving the box behind on top of whatever it was next to.

**When measuring positions for a flight path, use `offsetLeft`/`offsetTop`
accumulated up the `offsetParent` chain to a common positioned ancestor** — not
`getBoundingClientRect`. The stage is scaled by a CSS transform, so client rects
report scaled geometry and every path is wrong by the preview's zoom factor:
correct on one screen, wrong on the next. Also beware that any absolutely
positioned wrapper becomes its own `offsetParent`, so a single `offsetLeft` from
two different subtrees is measured against two different origins.

## 10 · Standard to hold

Do not produce the current default AI-design look: warm cream with a serif and a
terracotta accent, near-black with one acid-green pop used decoratively,
purple-to-blue gradient heroes, Inter everywhere, emoji as section markers,
everything centred, rounded cards with an accent bar down the side.

Every colour and type decision above should be traceable to something true about
the subject. Where you deviate from this brief, deviate deliberately and say why.
