# TikTok script

Two cuts of the same idea. The 45-second one is the real ask; the 22-second one
is what you post first to see whether the hook works before spending effort on
the long edit.

The whole thing rests on one visual — the author column in `git log` holding
three different names. Every dev who sees it knows that column says one name.
Get to it fast and let it sit on screen.

---

## Cut A — 22 seconds

Post this one first. If it dies, the hook is wrong and the 45 is wasted effort.

| t | Visual | Voiceover | On-screen text |
|---|---|---|---|
| 0–2 | Terminal, already typed, cursor blinking on `git log --pretty='%<(16)%an  %s' -5` | "Watch the author column." | **watch the author column** |
| 2–5 | Press enter. Five lines appear. Hold. | — | — |
| 5–11 | Slow zoom on the names. | "Three different AI agents. Three different people's accounts. Same repo, same minute." | — |
| 11–16 | Cut to the room: two people, colour-coded, two agents replying | "They're not one shared login. Each person brings their own agent, on their own subscription." | — |
| 16–22 | Back to terminal, whole log | "That column normally says one name. Whoever's laptop ran the commit." | **free · self-hosted · link in bio** |

Hard cut at the end. No sign-off, no "if you liked this".

---

## Cut B — 45 seconds

### 0–4s · Hook

**Visual:** black, then two lines of type, the `n` set in monospace so it reads
as a variable. Held, then the voices scene follows.

```
n people.
m agents.
```

**VO:** "Everyone's building one developer with many agents. This is the other n."

**Text:** none. The two lines *are* the text, and an overlay on top of them
would be saying the same thing twice.

> Two alternates, in case the first tests badly. Shoot both, they're one line
> each and they run over the same visual:
> - "Put three people behind one AI session and watch what happens."
> - "This is the bug nobody talks about in AI pair programming."
>
> The variable framing is doing real work here, so don't lose it in the
> alternates: every competitor scales one developer across many agents. This
> scales the other axis, and the audience is precisely the audience that reads
> `n` as a variable rather than a typo.
>
> **Two letters, not one.** `n people, n agents` says the two are equal, and
> they are not — a member runs a coder and a reviewer at once, which is the
> point of half the addressing code. The same audience that reads `n` correctly
> will read the repetition as a claim and notice it is false.

### 4–12s · The problem, concretely

**Visual:** two cursors typing into the same session; the replies contradict
each other.

**VO:** "Two people, one session. It can't tell who asked for what. It can't
tell agreement from disagreement. And it has no idea whose laptop to write the
file to."

**Text:** `whose file? whose preference? whose machine?`

### 20–28s · Bring your own

**Visual:** two member rows with empty dashed slots, and a tray of agents below —
Claude Code, Codex, Gemini, Ollama. One is picked up and arcs into `@mellery`'s
slot; a *different* one arcs into `@swhitfield`'s. Each takes its owner's colour
on landing.

**VO:** "Everyone brings their own. Different vendors, different subscriptions,
same room — and each one runs on its owner's machine, under their permissions."

**Text:** `bring your own`

> Names, not logos: accurate, and it keeps other people's trademarks out of an
> advert. The gesture is real — you drag an agent onto the room in the tree.

### 12–18s · The turn

**Visual:** the Ripieno room. Two members in the roster, each with an agent,
each in their own colour. A message goes in; both names are visible.

**VO:** "So — the other version. Everyone brings their own agent. Every message
carries who said it, and the server keeps that, not the client."

**Text:** `Ripieno`

### 18–34s · The proof

**Visual:** split screen for 3 seconds — two editor windows, two people, both
agents working — then **cut to full-screen terminal**.

**VO:** "Two agents. Two different people. Writing to the same repository at the
same time."

Run it live:

```
$ npm run demo:provenance
```

Then the payoff, full screen, held for four full seconds:

```
$ git log --pretty='%<(16)%an  %s' -5

  Alex's agent      Mention the limits in the README
  Sam's reviewer    Write down both limits
  Mira's coder      Bound the transcript
  Sam's reviewer    Cover the rate limit
  Mira's coder      Add rate limit to relay
```

**VO:** "That column normally holds one name — whoever's machine ran the commit.
Here it's whichever agent actually did the work."

**Text:** `git log knows who did it`

### 34–45s · Close

**Visual:** the terminal, one command.

**VO:** "It runs on your machine. Your relay, your data, nothing in the middle —
there's no service to sign up for and there never will be. One command to set
up. It's free."

```
git clone github.com/ijmh2/ripieno && npm run setup
```

**Text:** `free · open source · self-hosted`

---

## Production notes

**Speed-ramp the thinking.** An agent takes 20–60 seconds to answer and the room
shows nothing while it works. Speed it 8× with a visible time indicator, or cut
on the action. Do **not** cut it so it looks instant — people will install it,
wait 40 seconds at a blank screen, and feel lied to. A `⏱ 30s →` overlay is
honest and costs nothing.

**Record at 1080×1920 or crop deliberately.** Terminal text is the entire payoff
and unreadable text kills it. Font at 18pt minimum, high contrast, and zoom in
rather than showing the whole screen. Check it on your phone before posting.

**The demo is real, so run it live.** `npm run demo:provenance` uses the actual
container code against a real repository and writes concurrently on purpose. Do
not fake the output — the fact that it's real is the thing worth having, and one
person in the comments will clone it and check.

**Caption:** lead with the claim, not the name.

> Two people, two AI agents, one repo — and git log names each agent correctly.
> Everything runs on your own machine. Free and open source.
> github.com/ijmh2/ripieno

**Comment to pin:** "Each person uses their own Claude/Codex/whatever
subscription — nothing is shared and there's no server in the middle. You host
the relay yourself, or run it solo with no relay at all."

## What not to claim

- **Not on the VS Code Marketplace.** You install a `.vsix`. Say so if asked.
- **No users yet.** Don't imply a community that doesn't exist.
- **Don't call it real-time.** There's no streaming; you see the answer when
  it's finished.
- **Don't compare to Cursor or Copilot.** Different problem, and the comparison
  invites "isn't this just…" replies you'll lose.
- **If someone says Zed already does this** — they're partly right, and the
  honest answer is stronger than a dodge: Zed's multiplayer is excellent and
  runs on Zed's servers, in Zed. This is self-hosted, in VS Code, and each
  person brings their own agent rather than sharing one session.
