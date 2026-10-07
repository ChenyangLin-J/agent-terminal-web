import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordSessionMemoryExtraction, sessionMemoryContextFingerprint, validateSessionMemoryReview } from "../lib/session-memory-diagnostics.js";

const conversation = {
  recent: [
    { role: "user", text: "我一直偏好简洁的回答。" },
    { role: "assistant", text: "我会记录这个偏好。" },
  ],
  fresh: [
    { role: "user", text: "这周的排期只是暂时的，不用记住。" },
    { role: "assistant", text: "助手独有的解释，不是用户原话。" },
  ],
  lastEventAt: "2026-10-07T02:00:00.000Z",
};

function output(review, candidates = {}) {
  return {
    proposals: candidates.proposals || [],
    projectRules: candidates.projectRules || [],
    skills: candidates.skills || [],
    review,
  };
}

const noCandidatesReview = {
  assessment: "no_candidates",
  rationale: "本轮只有短期排期，没有可沉淀的长期信息。",
  skipped: [{
    reason: "transient",
    evidenceQuote: "这周的排期只是暂时的，不用记住。",
    matchedId: "",
    rationale: "用户明确说明这是短期信息。",
  }],
};

test("snapshot fingerprints detect user edits and pending decisions without depending on file timestamps", () => {
  const entry = { id: "memory-one", status: "confirmed", scope: "global", text: "正在读书。", updatedAt: "old" };
  const pending = { id: "pending-one", status: "pending", targetType: "personal_memory", action: "create", after: { text: "正在练习。" } };
  const fingerprint = sessionMemoryContextFingerprint([entry], [pending]);
  assert.equal(fingerprint, sessionMemoryContextFingerprint([{ ...entry, updatedAt: "new" }], [pending]));
  assert.notEqual(fingerprint, sessionMemoryContextFingerprint([{ ...entry, text: "已停止阅读。" }], [pending]));
  assert.notEqual(fingerprint, sessionMemoryContextFingerprint([entry], [{ ...pending, status: "rejected" }]));
});

test("records valid zero-candidate reviews repeatedly without prompt or transcript", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-diagnostics-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = output(noCandidatesReview);
  const review = validateSessionMemoryReview(value, { conversation });
  assert.equal(review.assessment, "no_candidates");

  const first = await recordSessionMemoryExtraction({
    thread: { id: "thread-1", title: "记忆讨论" },
    conversation,
    afterTimestamp: "2026-10-07T01:00:00.000Z",
    prompt: "secret prompt text that must not be logged",
    output: value,
  }, { runtimeRoot: root });
  await recordSessionMemoryExtraction({ thread: { id: "thread-1", title: "记忆讨论" }, conversation, output: value }, { runtimeRoot: root });
  assert.equal(first.modelReview.source, "model_explanation");
  assert.deepEqual(first.emitted, { proposals: 0, projectRules: 0, skills: 0 });

  const file = path.join(root, "session-extractions.jsonl");
  const saved = await fs.readFile(file, "utf8");
  assert.equal(saved.trim().split("\n").length, 2);
  assert.doesNotMatch(saved, /secret prompt text|助手独有的解释/);
  assert.match(saved, /[a-f0-9]{64}/);
  assert.equal((await fs.stat(root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("rejects malformed reviews, mismatched assessments, and assistant-only evidence", () => {
  assert.throws(() => validateSessionMemoryReview(output({ assessment: "no_candidates", rationale: "", skipped: [] }), { conversation }), /rationale/);
  assert.throws(() => validateSessionMemoryReview(output(noCandidatesReview, { proposals: [{}] }), { conversation }), /不一致/);
  assert.throws(() => validateSessionMemoryReview(output({ ...noCandidatesReview, skipped: [{ ...noCandidatesReview.skipped[0], evidenceQuote: "助手独有的解释，不是用户原话。" }] }), { conversation }), /用户消息/);
  assert.throws(() => validateSessionMemoryReview(output({ assessment: "no_candidates", rationale: "没有符合条件的信息", skipped: [] }), { conversation }), /本轮用户/);
});

test("requires real confirmed and pending ids, while accepting valid duplicate references", () => {
  const existingEntries = [{ id: "memory-concise", status: "confirmed" }];
  const reviewDecisions = [
    { id: "change-pending", status: "pending", targetType: "personal_memory" },
    { id: "change-approved", status: "approved", targetType: "personal_memory" },
  ];
  const duplicate = output({
    assessment: "no_candidates",
    rationale: "已有记忆和待审批变更已覆盖用户的长期表达。",
    skipped: [
      { reason: "already_covered", evidenceQuote: "我一直偏好简洁的回答。", matchedId: "memory-concise", rationale: "已存在同义确认记忆。" },
      { reason: "pending_covered", evidenceQuote: "我一直偏好简洁的回答。", matchedId: "change-pending", rationale: "待审批候选已经覆盖。" },
      noCandidatesReview.skipped[0],
    ],
  });
  assert.equal(validateSessionMemoryReview(duplicate, { conversation, existingEntries, reviewDecisions }).skipped.length, 3);
  assert.throws(() => validateSessionMemoryReview(output({ ...duplicate.review, skipped: [{ ...duplicate.review.skipped[0], matchedId: "unknown" }] }), { conversation, existingEntries, reviewDecisions }), /已确认/);
  assert.throws(() => validateSessionMemoryReview(output({ ...duplicate.review, skipped: [{ ...duplicate.review.skipped[1], matchedId: "change-approved" }] }), { conversation, existingEntries, reviewDecisions }), /待审批/);
});

test("accepts an actionable output with a positive proposal", () => {
  const proposal = { scope: "global", action: "create", targetId: "", mergePendingId: "", text: "偏好简洁回答", evidenceQuote: "我一直偏好简洁的回答。" };
  const value = output({ assessment: "actionable", rationale: "用户给出了稳定偏好。", skipped: [] }, { proposals: [proposal] });
  assert.deepEqual(validateSessionMemoryReview(value, { conversation }), {
    assessment: "actionable",
    rationale: "用户给出了稳定偏好。",
    skipped: [],
  });
  assert.throws(() => validateSessionMemoryReview({ ...value, proposals: [{ ...proposal, evidenceQuote: "助手独有的解释，不是用户原话。" }] }, { conversation }), /proposal.evidenceQuote/);
  assert.throws(() => validateSessionMemoryReview({ ...value, proposals: [{ ...proposal, mergePendingId: "unknown" }] }, { conversation }), /mergePendingId/);
  assert.throws(() => validateSessionMemoryReview({ ...value, proposals: [{ ...proposal, action: "update", targetId: "unknown" }] }, { conversation }), /targetId/);
});

test("accepts a pending update only when it matches the confirmed target and pending action", () => {
  const existingEntries = [{ id: "memory-concise", status: "confirmed" }];
  const pending = { id: "pending-update", status: "pending", targetType: "personal_memory", action: "update", entryId: "memory-concise" };
  const proposal = { scope: "global", action: "update", targetId: "memory-concise", mergePendingId: "pending-update", text: "偏好简洁回答", evidenceQuote: "我一直偏好简洁的回答。" };
  const value = output({ assessment: "actionable", rationale: "更新已有待审内容。", skipped: [] }, { proposals: [proposal] });
  assert.equal(validateSessionMemoryReview(value, { conversation, existingEntries, reviewDecisions: [pending] }).assessment, "actionable");
  assert.throws(() => validateSessionMemoryReview(value, { conversation, existingEntries, reviewDecisions: [{ ...pending, action: "create" }] }), /mergePendingId/);
  assert.throws(() => validateSessionMemoryReview(value, { conversation, existingEntries, reviewDecisions: [{ ...pending, entryId: "other-memory" }] }), /mergePendingId/);
});
