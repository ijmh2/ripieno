# Provenance

The one idea this project refuses to compromise on: **the agent always knows who
said what, and whose machine it is acting on.**

## Why a shared login isn't this

Put three people behind one agent session and you get a transcript that reads
like a single schizophrenic user. The agent cannot tell agreement from
disagreement, cannot tell whose preferences to honour, and cannot tell whose
filesystem the next `rm` lands on. Everything it knows about authorship has been
thrown away at the door.

Provenance is the refusal to throw it away.

## Two halves

**Attribution** is inbound. Every message the agent receives carries its author.
Not as a courtesy prefix the model may ignore, but as structure the room core
maintains: `Mira Ellery (@ijmh2): …`. The agent is instructed never to merge two
members' statements into one anonymous "the team thinks". If two people disagree,
that disagreement survives into the agent's reasoning intact.

**Scoping** is outbound. A tool call is not a free-floating action; it belongs to
whoever asked for it. Reading a file, running a test, opening an app — all of it
executes on the asking member's own machine, under their own permissions, with
their own approval prompts. The relay owns the conversation. It does not own
anybody's disk.

## The consequence worth noticing

These two halves make the permission model *legible*. When the agent tries
something and gets denied, the denial is attributable too: a specific person
declined a specific action on their own machine. Nobody can be quietly volunteered
into an action by someone else's question, and the agent can say so out loud in
the room instead of failing into silence.

That is the whole design. One conversation, several people, no anonymity, no
borrowed hands.
