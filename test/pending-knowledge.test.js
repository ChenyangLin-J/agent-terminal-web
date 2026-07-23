import assert from "node:assert/strict";
import test from "node:test";
import { pendingKnowledgeContext, pendingMergeInstructions } from "../lib/pending-knowledge.js";

test("pending context includes only unresolved knowledge proposals and can be type-scoped", () => {
  const context = pendingKnowledgeContext([
    { id: "personal", targetType: "personal_memory", status: "pending", after: { text: "个人" } },
    { id: "project", targetType: "project_rule", status: "pending", after: { text: "项目" } },
    { id: "old", targetType: "personal_memory", status: "superseded", after: { text: "旧候选" } },
    { id: "audit", targetType: "native_review", status: "pending", after: { text: "审计" } },
  ], { types: ["personal_memory"] });

  assert.deepEqual(context.map((change) => change.id), ["personal"]);
  assert.match(pendingMergeInstructions(), /same target type and target document/);
  assert.match(pendingMergeInstructions(), /emit nothing/);
});
