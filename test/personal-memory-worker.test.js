import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPersonalMemoryExtractionPrompt,
  conversationFromRollout,
  hasCompletedFreshTurn,
  recordWorkerUsage,
  shouldProcessConversation,
  usageAlertNeeded,
  usageFromCodexEvents,
} from "../lib/personal-memory-worker.js";

test("worker reads only user and final-answer events after its watermark", () => {
  const raw = [
    event("2026-07-21T10:00:00Z", { type: "user_message", message: "我喜欢具体回答" }),
    event("2026-07-21T10:00:01Z", { type: "agent_message", phase: "commentary", message: "过程" }),
    event("2026-07-21T10:00:02Z", { type: "agent_message", phase: "final_answer", message: "知道了" }),
    event("2026-07-21T10:10:00Z", { type: "user_message", message: "以后也请分析利弊" }),
  ].join("\n");
  const conversation = conversationFromRollout(raw, "2026-07-21T10:00:02Z");
  assert.deepEqual(conversation.recent.map((item) => item.text), ["我喜欢具体回答", "知道了"]);
  assert.deepEqual(conversation.fresh.map((item) => item.text), ["以后也请分析利弊"]);
  assert.equal(hasCompletedFreshTurn(conversation), false);
  assert.equal(shouldProcessConversation({ title: "交流偏好" }, conversation), true);
  const completed = conversationFromRollout(`${raw}\n${event("2026-07-21T10:10:02Z", {
    type: "agent_message",
    phase: "final_answer",
    message: "以后会分析利弊。",
  })}`, "2026-07-21T10:00:02Z");
  assert.equal(hasCompletedFreshTurn(completed), true);
  const prompt = buildPersonalMemoryExtractionPrompt({
    thread: {
      id: "one",
      memoryProjectMode: "manual",
      memoryProjects: ["agent-terminal-web", "home-portal"],
    },
    conversation,
    existingEntries: [],
    reviewDecisions: [{
      targetType: "project_rule",
      targetPath: "/workspace/home-portal/AGENTS.md",
      status: "rejected",
      after: { text: "Home Session 标题保持一致。" },
      rationale: "系统曾把它当成项目规则。",
      reviewReason: "这是产品验收标准。",
    }],
  });
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /"memoryProjectMode":"manual"/);
  assert.match(prompt, /"activeMemoryProjects":\["agent-terminal-web","home-portal"\]/);
  assert.match(prompt, /projectRules/);
  assert.match(prompt, /skills/);
  assert.match(prompt, /Personal memory is always scope "global"/);
  assert.match(prompt, /feature requests, acceptance criteria/);
  assert.match(prompt, /current-turn or follow-up requirements/);
  assert.match(prompt, /different future task in the same repository/);
  assert.match(prompt, /always require review/);
  assert.match(prompt, /Personal memories, project rules, and Skills are proposals only/);
  assert.match(prompt, /existing first-level directory directly under the workspace root/);
  assert.match(prompt, /local calibration examples/);
  assert.match(prompt, /Home Session 标题保持一致/);
  assert.match(prompt, /系统曾把它当成项目规则/);
  assert.match(prompt, /这是产品验收标准/);
});

test("worker ignores synthetic probes and records usage without imposing a cap", () => {
  const conversation = { recent: [], fresh: [{ role: "user", text: "Reply exactly DONE" }] };
  assert.equal(shouldProcessConversation({ title: "Reply exactly DONE" }, conversation), false);
  assert.deepEqual(
    usageFromCodexEvents(`${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 50 } })}\n`),
    { inputTokens: 1200, outputTokens: 50 },
  );
  const runtime = {
    usage: { totalRuns: 0, totalInputTokens: 0, totalOutputTokens: 0, days: {}, lastAlertedDay: "" },
  };
  recordWorkerUsage(runtime, { inputTokens: 200_000, outputTokens: 60_000 }, new Date("2026-07-21T12:00:00+08:00"));
  assert.equal(usageAlertNeeded(runtime, new Date("2026-07-21T12:01:00+08:00")).total, 260_000);
  assert.equal(runtime.usage.totalRuns, 1);
});

function event(timestamp, payload) {
  return JSON.stringify({ timestamp, type: "event_msg", payload });
}
