const { test, describe } = require("node:test");
const assert = require("node:assert/strict");

const { approvalInputHash } = require("../dist/approvalScope.js");

describe("standing approval scope", () => {
  test("the same complete input keeps the same identity", () => {
    const input = { command: "npm test", timeout: 30 };
    assert.equal(approvalInputHash(input), approvalInputHash(input));
  });

  test("commands that differ after the visible summary do not share consent", () => {
    const shared = "x".repeat(650);
    assert.notEqual(
      approvalInputHash({ command: `${shared} --safe` }),
      approvalInputHash({ command: `${shared} --dangerous` })
    );
  });

  test("non-primary values remain part of the trust decision", () => {
    assert.notEqual(
      approvalInputHash({ path: "src/config.ts", content: "safe" }),
      approvalInputHash({ path: "src/config.ts", content: "different" })
    );
  });
});
