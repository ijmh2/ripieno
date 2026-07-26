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
