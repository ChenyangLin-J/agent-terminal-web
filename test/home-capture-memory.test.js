import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildHomeCaptureMemoryPrompt,
  homeCaptureReviewBatch,
  reviewedHomeCaptureState,
  verifiedHomeCaptureProposal,
} from "../lib/home-capture-memory.js";

test("Home capture memory reviews completed voice captures incrementally", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "home-capture-memory-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "capture-jobs.json");
  await fs.writeFile(file, JSON.stringify({ jobs: [
    { id: "voice-1", source: "voice", status: "done", createdAt: "2026-07-01", completedAt: "2026-07-01", rawText: "我希望长期学习藏语，但不想设置学习 KPI。", items: [{ id: "i1", type: "thought", markdown: "想法" }] },
    { id: "text-1", source: "text", status: "done", rawText: "文字记录", items: [{ id: "i2", type: "thought", markdown: "想法" }] },
    { id: "voice-2", source: "voice", status: "processing", rawText: "处理中", items: [] },
  ] }));

  const first = await homeCaptureReviewBatch(file, {});
  assert.deepEqual(first.captures.map((capture) => capture.id), ["voice-1"]);
  const state = reviewedHomeCaptureState({}, first.captures);
  assert.deepEqual((await homeCaptureReviewBatch(file, state)).captures, []);

  await fs.writeFile(file, JSON.stringify({ jobs: [{ ...JSON.parse(await fs.readFile(file)).jobs[0], rawText: "我希望长期学习藏语，但不想设置任何学习 KPI。" }] }));
  assert.deepEqual((await homeCaptureReviewBatch(file, state)).captures.map((capture) => capture.id), ["voice-1"]);
});

test("Home capture prompt keeps tasks in Home and verifies exact evidence", () => {
  const capture = { id: "voice-1", createdAt: "", rawText: "我希望长期学习藏语，但不想设置任何学习 KPI。", items: [{ type: "thought", markdown: "原文" }] };
  const prompt = buildHomeCaptureMemoryPrompt({ captures: [capture] });
  assert.match(prompt, /A task remains a Home task/);
  assert.match(prompt, /requires user approval/);
  assert.equal(verifiedHomeCaptureProposal({ evidenceCaptureId: "voice-1", evidenceQuote: "长期学习藏语，但不想设置任何学习 KPI" }, capture), true);
  assert.equal(verifiedHomeCaptureProposal({ evidenceCaptureId: "voice-2", evidenceQuote: "长期学习藏语，但不想设置任何学习 KPI" }, capture), false);
  assert.equal(verifiedHomeCaptureProposal({ evidenceCaptureId: "voice-1", evidenceQuote: "买牛奶" }, capture), false);
});
