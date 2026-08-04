/**
 * Who answers a message — decided before a turn runs, not after.
 *
 * The cost of getting this wrong is asymmetric and both directions are bad: too
 * loose and every agent in the room burns a turn on one question; too tight and
 * nobody answers and the room looks broken. So the rules are tested directly
 * rather than trusted.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { shouldAnswer, mentions } = require("../dist/addressing.js");

const mirasAgent = { label: "Mira Ellery's agent", handle: "ijmh2", primary: true };
const mirasReviewer = { label: "Mira Ellery's reviewer", handle: "ijmh2", primary: false };
const samsAgent = { label: "Sam Whitfield's agent", handle: "swhitfield", primary: true };

describe("an unaddressed question gets exactly one reply per member", () => {
  test("the primary answers", () => {
    assert.equal(shouldAnswer("what does the driver boundary do?", mirasAgent, [mirasReviewer]), true);
  });

  test("a non-primary stays quiet", () => {
    assert.equal(shouldAnswer("what does the driver boundary do?", mirasReviewer, [mirasAgent]), false);
  });
});

describe("naming an agent routes to it and silences the rest", () => {
  test("the named non-primary answers", () => {
    assert.equal(shouldAnswer("reviewer, is this sound?", mirasReviewer, [mirasAgent]), true);
  });

  test("its primary sibling stands down rather than burning a turn", () => {
    assert.equal(shouldAnswer("reviewer, is this sound?", mirasAgent, [mirasReviewer]), false);
  });

  test("naming someone else's agent stops yours running at all", () => {
    // The case that motivated this: Sam's agent used to run a full turn and then
    // decline, having already spent the tokens.
    assert.equal(
      shouldAnswer("I want @mira's agent to open safari", samsAgent, [mirasAgent, mirasReviewer]),
      false
    );
  });

  test("and the agent that was named does answer", () => {
    assert.equal(
      shouldAnswer("I want @mira's agent to open safari", mirasAgent, [samsAgent, mirasReviewer]),
      true
    );
  });

  test("an @handle addresses that member's agent", () => {
    assert.equal(shouldAnswer("@swhitfield can you check this?", samsAgent, [mirasAgent]), true);
    assert.equal(shouldAnswer("@swhitfield can you check this?", mirasAgent, [samsAgent]), false);
  });
});

describe("mention matching is generous but not reckless", () => {
  test("the full label matches", () => {
    assert.equal(mentions("ask Mira Ellery's reviewer about it", mirasReviewer), true);
  });

  test("curly apostrophes still match", () => {
    assert.equal(mentions("ask Mira Ellery’s reviewer about it", mirasReviewer), true);
  });

  test('"agent" alone names nobody, since every agent is one', () => {
    // Otherwise "can an agent look at this?" wakes every agent in the room.
    assert.equal(mentions("can an agent look at this?", mirasAgent), false);
    assert.equal(mentions("can an agent look at this?", samsAgent), false);
  });

  test("a bare first name in prose does not silently route", () => {
    // "Mira, what do you think?" is addressed to Mira the person.
    assert.equal(mentions("mira, what do you think?", mirasAgent), false);
  });

  test("a first name does route when it clearly means the agent", () => {
    assert.equal(mentions("get mira's agent to run the tests", mirasAgent), true);
    assert.equal(mentions("@mira run the tests", mirasAgent), true);
  });

  test("a substring of a longer word is not a mention", () => {
    // "reviewers" plural, or a word merely containing the handle, must not match.
    assert.equal(mentions("the reviewers meeting is at 4", mirasReviewer), false);
  });

  test("the room still answers a plain question when nobody is named", () => {
    assert.equal(shouldAnswer("does this build?", mirasAgent, [samsAgent, mirasReviewer]), true);
    assert.equal(shouldAnswer("does this build?", samsAgent, [mirasAgent, mirasReviewer]), true);
    // One reply per member, not one per agent.
    assert.equal(shouldAnswer("does this build?", mirasReviewer, [mirasAgent, samsAgent]), false);
  });
});

describe("a question asked while the agent is thinking still gets answered", () => {
  const { nextUnanswered } = require("../dist/addressing.js");
  const human = (text) => ({ kind: "human", text });
  const system = (text) => ({ kind: "system", text });
  const agent = (text) => ({ kind: "agent", text });

  test("a question followed by somebody joining is not lost", () => {
    // The recovery used to look only at the *last* entry and skip it unless it
    // was human, so a join notice arriving after the question meant nobody ever
    // answered — and the agent just looked like it was ignoring you.
    const queued = [human("does this build?"), system("Sam joined the room.")];
    assert.equal(nextUnanswered(queued, mirasAgent, [samsAgent])?.text, "does this build?");
  });

  test("a question followed by another agent's reply is not lost", () => {
    // In a room with several agents this is the ordinary case, not the edge one.
    const queued = [human("does this build?"), agent("I had a look and it does.")];
    assert.equal(nextUnanswered(queued, mirasAgent, [samsAgent])?.text, "does this build?");
  });

  test("the oldest unanswered question is the one picked up", () => {
    const queued = [human("first?"), human("second?")];
    assert.equal(nextUnanswered(queued, mirasAgent, [samsAgent])?.text, "first?");
  });

  test("a question addressed to somebody else is not picked up", () => {
    const queued = [human("@swhitfield can you check this?"), system("noise")];
    assert.equal(nextUnanswered(queued, mirasAgent, [samsAgent]), undefined);
  });

  test("nothing queued means nothing to do", () => {
    assert.equal(nextUnanswered([], mirasAgent, [samsAgent]), undefined);
    assert.equal(nextUnanswered([system("x"), agent("y")], mirasAgent, [samsAgent]), undefined);
  });
});

describe("people drop apostrophes, and it must still route", () => {
  // From a real room: "Where is miras agents final summary?" matched nobody, so
  // no agent counted as named and *both* answered — the wrong one first. The
  // failure is silent and costs a turn every time.
  test("an apostrophe-less possessive still names the agent", () => {
    assert.equal(mentions("Where is miras agents final summary?", mirasAgent), true);
    assert.equal(mentions("miras agent, do it", mirasAgent), true);
  });

  test("and it stops the other agent answering", () => {
    assert.equal(shouldAnswer("Where is miras agents final summary?", samsAgent, [mirasAgent]), false);
    assert.equal(shouldAnswer("Where is miras agents final summary?", mirasAgent, [samsAgent]), true);
  });

  test("asking sams agent does not wake miras", () => {
    assert.equal(shouldAnswer("sams agent can you check", mirasAgent, [samsAgent]), false);
    assert.equal(shouldAnswer("sams agent can you check", samsAgent, [mirasAgent]), true);
  });

  test("the apostrophe form still works, both kinds", () => {
    assert.equal(mentions("mira's agent, do it", mirasAgent), true);
    assert.equal(mentions("mira’s agent, do it", mirasAgent), true);
  });

  test("a plural is not a possessive", () => {
    // "the reviewers meeting" must still not wake the reviewer.
    assert.equal(mentions("the reviewers meeting is at 4", mirasReviewer), false);
  });

  test("a longer name starting the same way is still not a match", () => {
    assert.equal(mentions("miraka wants a look", mirasAgent), false);
  });
});

describe("naming one of somebody's agents does not wake the others", () => {
  // Seen in a live room: "Mira Ellery's agent you should be thinking now" woke the
  // reviewer as well, because the text contains "mira" and the word "agent".
  // Only the first name was left to go on by that point, and it cannot tell one
  // of a person's agents from another.
  test("the generic agent is the one a first name reaches", () => {
    const text = "Mira Ellery's agent you should be thinking now";
    assert.equal(shouldAnswer(text, mirasAgent, [mirasReviewer, samsAgent]), true);
    assert.equal(shouldAnswer(text, mirasReviewer, [mirasAgent, samsAgent]), false);
  });

  test("the reviewer still answers when actually named", () => {
    assert.equal(mentions("Mira Ellery's reviewer take a look", mirasReviewer), true);
    assert.equal(mentions("reviewer, is this sound?", mirasReviewer), true);
    assert.equal(mentions("miras reviewer, is this sound?", mirasReviewer), true);
  });

  test("and a bare first name still reaches the generic agent", () => {
    assert.equal(mentions("get mira's agent to run the tests", mirasAgent), true);
    assert.equal(mentions("get miras agent to run the tests", mirasAgent), true);
  });
});

describe("agents may address each other, twice, and only by name", () => {
  // Two agents that answer each other's every message talk until somebody
  // notices the bill, which is why they ignored each other entirely until now.
  // Both halves are needed: naming is what an agent chooses, so naming alone
  // bounds nothing; the hop count is stamped by the relay from its own
  // transcript, so it is not something a client can talk its way out of.
  const { answersEntry, nextUnanswered } = require("../dist/addressing.js");
  const fromAgent = (text, hops, agentId) => ({ kind: "agent", text, hops, agentId });
  const fromHuman = (text) => ({ kind: "human", text });

  test("a named agent answers another agent's first reply", () => {
    const entry = fromAgent("miras reviewer, does this hold up?", 1, "sam:1");
    assert.equal(answersEntry(entry, mirasReviewer, [mirasAgent, samsAgent]), true);
  });

  test("naming nobody wakes nobody, however shallow", () => {
    // The ordinary case: an agent answers its owner and says nothing about
    // anyone else. Every other agent must stay out of it.
    const entry = fromAgent("Done — the tests pass.", 1, "sam:1");
    assert.equal(answersEntry(entry, mirasAgent, [samsAgent]), false);
    assert.equal(answersEntry(entry, mirasReviewer, [samsAgent]), false);
  });

  test("the primary fallback does not apply to agents", () => {
    // A human question with no name in it still deserves one reply per member.
    // An agent statement with no name in it deserves none at all — the fallback
    // is exactly what would turn two agents into a conversation.
    const text = "does this build?";
    assert.equal(answersEntry(fromHuman(text), mirasAgent, [samsAgent]), true);
    assert.equal(answersEntry(fromAgent(text, 1, "sam:1"), mirasAgent, [samsAgent]), false);
  });

  test("a second hop is the last one", () => {
    const second = fromAgent("miras reviewer, one more thing", 2, "sam:1");
    assert.equal(answersEntry(second, mirasReviewer, [mirasAgent, samsAgent]), false);
    // Named just as clearly at depth 1, so it is the depth stopping it.
    const first = fromAgent("miras reviewer, one more thing", 1, "sam:1");
    assert.equal(answersEntry(first, mirasReviewer, [mirasAgent, samsAgent]), true);
  });

  test("an agent does not answer itself", () => {
    // An agent that signs off with its own name would otherwise wake itself,
    // which is the shortest loop available.
    const own = fromAgent("— Mira Ellery's reviewer", 1, "mira:reviewer");
    assert.equal(answersEntry(own, mirasReviewer, [mirasAgent], "mira:reviewer"), false);
    assert.equal(answersEntry(own, mirasReviewer, [mirasAgent], "mira:coder"), true);
  });

  test("a human can always restart a chain that has stopped", () => {
    const entry = fromHuman("reviewer, what did you make of that?");
    assert.equal(answersEntry(entry, mirasReviewer, [mirasAgent]), true);
  });

  test("recovery after a turn picks up an agent message that named us", () => {
    const queued = [fromAgent("nothing to see", 1, "sam:1"), fromAgent("miras reviewer?", 1, "sam:1")];
    assert.equal(nextUnanswered(queued, mirasReviewer, [mirasAgent, samsAgent])?.text, "miras reviewer?");
  });

  test("and skips one that is out of hops", () => {
    const queued = [fromAgent("miras reviewer?", 2, "sam:1")];
    assert.equal(nextUnanswered(queued, mirasReviewer, [mirasAgent, samsAgent]), undefined);
  });
});

describe("an older relay does not silently remove the bound", () => {
  // A new extension against a relay that has not been redeployed: it stamps no
  // depth, so there is nothing to stop a chain. The safe reading of "no count"
  // is the behaviour from before there was one — agents ignore each other —
  // rather than treating a missing number as zero and running unbounded.
  const { answersEntry } = require("../dist/addressing.js");

  test("an agent entry with no depth wakes nobody, even when named", () => {
    const entry = { kind: "agent", text: "miras reviewer, take a look", agentId: "sam:1" };
    assert.equal(answersEntry(entry, mirasReviewer, [mirasAgent, samsAgent]), false);
  });

  test("and humans are unaffected, since a human message never carries one", () => {
    const entry = { kind: "human", text: "does this build?" };
    assert.equal(answersEntry(entry, mirasAgent, [samsAgent]), true);
  });
});
