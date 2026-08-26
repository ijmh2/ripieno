import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONTEXT_AUDIT_ENTRIES,
  MAX_CONTEXT_BODY_CHARS,
  MAX_CONTEXT_ITEMS,
  MAX_CONTEXT_REQUESTS,
  MAX_CONTEXT_REQUEST_ID_CHARS,
  MAX_CONTEXT_TAG_CHARS,
  MAX_CONTEXT_TAGS,
  MAX_CONTEXT_TITLE_CHARS,
} from "../src/index.js";
import type { ClientMsg, ContextItem, ServerMsg } from "../src/index.js";

test("shared context is typed in both wire directions", () => {
  const item: ContextItem = {
    id: "context_server-minted",
    kind: "decision",
    title: "Use the relay as authority",
    body: "Clients reconcile against a monotonic revision.",
    tags: ["architecture"],
    status: "accepted",
    authorHandle: "mellery",
    authorName: "Mira",
    version: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const create: ClientMsg = {
    t: "contextCreate",
    requestId: "ctxreq_1",
    kind: item.kind,
    title: item.title,
    body: item.body,
    tags: item.tags,
  };
  const update: ClientMsg = {
    t: "contextUpdate",
    requestId: "ctxreq_2",
    contextId: item.id,
    expectedVersion: 1,
    status: "archived",
  };
  const state: ServerMsg = {
    t: "context",
    context: [item],
    contextAudit: [],
    contextRevision: 1,
  };
  const result: ServerMsg = {
    t: "contextResult",
    requestId: "ctxreq_1",
    ok: true,
    item,
    contextRevision: 1,
  };
  assert.deepEqual([create.t, update.t, state.t, result.t], [
    "contextCreate",
    "contextUpdate",
    "context",
    "contextResult",
  ]);
});

test("every durable context collection and field has a finite cap", () => {
  for (const bound of [
    MAX_CONTEXT_ITEMS,
    MAX_CONTEXT_TITLE_CHARS,
    MAX_CONTEXT_BODY_CHARS,
    MAX_CONTEXT_TAGS,
    MAX_CONTEXT_TAG_CHARS,
    MAX_CONTEXT_AUDIT_ENTRIES,
    MAX_CONTEXT_REQUESTS,
    MAX_CONTEXT_REQUEST_ID_CHARS,
  ]) {
    assert.ok(Number.isSafeInteger(bound) && bound > 0);
  }
});
