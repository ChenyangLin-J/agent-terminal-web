import assert from "node:assert/strict";
import test from "node:test";
import { orderKnowledgeChanges } from "../lib/knowledge-change-order.js";

test("knowledge changes keep pending first and sort each group by its relevant time", () => {
  const changes = [
    { id: "recently-created-old-review", status: "approved", createdAt: "2026-07-22T12:00:00Z", resolvedAt: "2026-07-22T12:05:00Z" },
    { id: "older-created-new-review", status: "rejected", createdAt: "2026-07-20T12:00:00Z", resolvedAt: "2026-07-22T13:00:00Z" },
    { id: "older-pending", status: "pending", createdAt: "2026-07-22T10:00:00Z" },
    { id: "newer-pending", status: "pending", createdAt: "2026-07-22T11:00:00Z" },
  ];

  assert.deepEqual(orderKnowledgeChanges(changes).map((change) => change.id), [
    "newer-pending",
    "older-pending",
    "older-created-new-review",
    "recently-created-old-review",
  ]);
});
