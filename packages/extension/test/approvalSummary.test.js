const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const {
  canStoreStandingApproval,
  summariseApprovalInput,
} = require("../dist/approvalSummary.js");

describe("approval summary inspectability", () => {
  test("complete short values may be remembered", () => {
    assert.deepEqual(summariseApprovalInput("npm test"), {
      text: "npm test",
      rememberable: true,
    });
    assert.deepEqual(summariseApprovalInput({ command: "npm test" }), {
      text: "command: npm test",
      rememberable: true,
    });
    assert.deepEqual(summariseApprovalInput({ glob: "src/**/*.ts", limit: 20 }), {
      text: '{\n  "glob": "src/**/*.ts",\n  "limit": 20\n}',
      rememberable: true,
    });
  });

  test("truncated values may not be remembered", () => {
    const result = summariseApprovalInput({ command: "x".repeat(601) });
    assert.equal(result.rememberable, false);
    assert.match(result.text, /^command: x{600}…$/);

    const fallback = summariseApprovalInput({ payload: "x".repeat(700) });
    assert.equal(fallback.rememberable, false);
    assert.equal(fallback.text.endsWith("…"), true);
  });

  test("a primary field plus omitted fields may not be remembered", () => {
    assert.deepEqual(summariseApprovalInput({ path: "src/config.ts", content: "secret" }), {
      text: "path: src/config.ts\n(plus content)",
      rememberable: false,
    });
  });
});

describe("standing approval host guard", () => {
  test("stores only an always verdict for a fully inspectable request", () => {
    assert.equal(canStoreStandingApproval("always", true), true);
    assert.equal(canStoreStandingApproval("always", false), false);
    assert.equal(canStoreStandingApproval("once", true), false);
    assert.equal(canStoreStandingApproval("deny", true), false);
    assert.equal(canStoreStandingApproval("forged", true), false);
  });
});
