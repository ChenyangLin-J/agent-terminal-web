import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildNativeMemoryReviewPrompt,
  captureNativeMemorySnapshot,
  nativeMemoryDelta,
  nativeMemorySnapshotState,
  verifiedNativeCandidate,
} from "../lib/native-memory-review.js";

test("native memory review reads only generated Markdown and only changed sections", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "native-review-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const memories = path.join(codexHome, "memories");
  await fs.mkdir(path.join(memories, "rollout_summaries"), { recursive: true });
  await fs.mkdir(path.join(memories, "extensions", "ad_hoc"), { recursive: true });
  await fs.writeFile(path.join(memories, "raw_memories.md"), "# Raw Memories\n\n## Thread `thread-12345678`\nold fact\n");
  await fs.writeFile(path.join(memories, "rollout_summaries", "one.md"), "thread_id: thread-abcdefgh\n# Summary\nStable\n");
  await fs.writeFile(path.join(memories, "extensions", "ad_hoc", "instructions.md"), "do not read\n");

  const initial = await captureNativeMemorySnapshot(codexHome);
  const firstDelta = nativeMemoryDelta(null, initial);
  assert.deepEqual(Object.keys(initial.files).sort(), ["raw_memories.md", "rollout_summaries/one.md"]);
  assert.equal(firstDelta.changed, true);
  assert.ok(firstDelta.changedSections.some((section) => section.content.includes("old fact")));

  const state = nativeMemorySnapshotState(initial);
  assert.equal(nativeMemoryDelta(state, await captureNativeMemorySnapshot(codexHome)).changed, false);
  await fs.writeFile(
    path.join(memories, "raw_memories.md"),
    "# Raw Memories\n\n## Thread `thread-12345678`\nnew fact\n\n## Thread `thread-87654321`\nanother fact\n",
  );
  const changed = nativeMemoryDelta(state, await captureNativeMemorySnapshot(codexHome));
  assert.equal(changed.changed, true);
  assert.equal(changed.changedSections.filter((section) => section.file === "raw_memories.md").length, 2);
  assert.ok(changed.changedSections.every((section) => !section.content.includes("do not read")));
});

test("native review prompt excludes audit-only decisions and requires transcript-verifiable quotes", () => {
  const prompt = buildNativeMemoryReviewPrompt({
    delta: {
      fingerprint: "abc",
      changedFiles: ["raw_memories.md"],
      deleted: [],
      omittedSections: 0,
      changedSections: [{ file: "raw_memories.md", heading: "Thread", threadId: "thread-1", content: "user said：我偏好具体回答", truncated: false }],
    },
    personalDocuments: [{ path: "Core.md", content: "具体回答" }],
    projectDocuments: [],
    reviewDecisions: [
      { targetType: "native_review", status: "approved", after: { text: "audit-only-marker" } },
      { targetType: "personal_memory", status: "rejected", after: { text: "candidate" } },
    ],
  });
  assert.match(prompt, /original user transcript/);
  assert.match(prompt, /candidate/);
  assert.doesNotMatch(prompt, /audit-only-marker/);
  assert.equal(verifiedNativeCandidate({ evidenceQuote: "我偏好具体并且有依据的回答" }, ["之前说过：我偏好具体并且有依据的回答。"]), true);
  assert.equal(verifiedNativeCandidate({ evidenceQuote: "可以" }, ["可以"]), false);
  assert.equal(verifiedNativeCandidate({ evidenceQuote: "不存在的偏好" }, ["另一个内容"]), false);
});
