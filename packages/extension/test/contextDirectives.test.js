/**
 * How a provider with no tool channel proposes room memory.
 *
 * The block is the only structured thing a headless CLI can emit, so the parser
 * has to be strict about what counts and unforgiving about what reaches the
 * room: a malformed block is still machine syntax, and posting it under an
 * agent's name would be worse than dropping it.
 */

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const Module = require("node:module");
const originalResolve = Module._resolveFilename;
const STUB = path.join(__dirname, "vscode-stub.js");
Module._resolveFilename = function (request, ...rest) {
  if (request === "vscode") return STUB;
  return originalResolve.call(this, request, ...rest);
};

const {
  MAX_DIRECTIVES_PER_TURN,
  describeContextDirective,
  extractContextProposals,
} = require("../dist/contextDirectives.js");

const block = (value) => ["```ripieno-context", JSON.stringify(value), "```"].join("\n");

describe("context directives", () => {
  test("a well-formed block becomes a proposal and leaves the reply", () => {
    const { text, proposals } = extractContextProposals(
      [
        "We agreed to keep the relay authoritative.",
        block({
          kind: "decision",
          title: "Relay is authoritative",
          body: "Clients reconcile against a revision.",
          tags: ["architecture"],
        }),
      ].join("\n\n")
    );
    assert.equal(text, "We agreed to keep the relay authoritative.");
    assert.deepEqual(proposals, [
      {
        kind: "decision",
        title: "Relay is authoritative",
        body: "Clients reconcile against a revision.",
        tags: ["architecture"],
      },
    ]);
  });

  test("a reply with no block is returned untouched", () => {
    const reply = "Nothing to record here.\n\n```ts\nconst x = 1;\n```";
    const { text, proposals } = extractContextProposals(reply);
    assert.equal(text, reply);
    assert.deepEqual(proposals, []);
  });

  test("malformed and unknown-kind blocks are dropped, not posted", () => {
    const { text, proposals } = extractContextProposals(
      ["Here you go.", "```ripieno-context", "{not json", "```", block({ kind: "gossip", title: "x" })].join("\n\n")
    );
    assert.deepEqual(proposals, []);
    assert.equal(text, "Here you go.");
    assert.equal(text.includes("ripieno-context"), false);
  });

  test("a block with no title is not a proposal", () => {
    const { proposals } = extractContextProposals(block({ kind: "fact", title: "   " }));
    assert.deepEqual(proposals, []);
  });

  test("the number of proposals per turn is bounded", () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      block({ kind: "note", title: `Note ${i}` })
    ).join("\n\n");
    const { text, proposals } = extractContextProposals(many);
    assert.equal(proposals.length, MAX_DIRECTIVES_PER_TURN);
    assert.equal(text, "", "the surplus blocks are still removed from the reply");
  });

  test("fields and tags are capped before they leave", () => {
    const { proposals } = extractContextProposals(
      block({
        kind: "reference",
        title: "t".repeat(500),
        body: "b".repeat(9_000),
        tags: Array.from({ length: 30 }, (_, i) => `tag-${i}-${"x".repeat(80)}`),
      })
    );
    assert.equal(proposals[0].title.length, 160);
    assert.equal(proposals[0].body.length, 4_000);
    assert.equal(proposals[0].tags.length, 8);
    assert.ok(proposals[0].tags.every((tag) => tag.length <= 32));
  });

  test("the instruction offers the action without demanding it be used", () => {
    const described = describeContextDirective();
    assert.match(described, /ripieno-context/);
    assert.match(described, /unverified\nuntil a person accepts it/);
    assert.match(described, /not for chat/);
  });
});
