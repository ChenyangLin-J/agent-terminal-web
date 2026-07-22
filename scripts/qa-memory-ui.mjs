#!/usr/bin/env node
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.QA_AGENT_URL || "http://127.0.0.1:3137";
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 430, height: 932 },
  ]) {
    const page = await browser.newPage({ viewport });
    await page.route("**/api/auth", (route) => route.fulfill({ json: { authenticated: true } }));
    await page.route("**/api/projects", (route) => route.fulfill({ json: { workspaceRoot: "/workspace", projects: [] } }));
    await page.route("**/api/sessions**", (route) => route.fulfill({ json: { sessions: [] } }));
    await page.route("**/api/codex-sessions**", (route) => route.fulfill({ json: { sessions: [] } }));
    await page.route("**/api/memories/status", (route) => route.fulfill({ json: memoryPayload("status") }));
    await page.route(/\/api\/memories\?.*/, (route) => {
      const view = new URL(route.request().url()).searchParams.get("view") || "overview";
      return route.fulfill({ json: memoryPayload(view) });
    });
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.querySelector("#start-screen")?.classList.remove("hidden"));
    await page.click("#open-memories");
    await page.waitForSelector(".memory-markdown-file");
    assert.match(await page.locator(".memory-automation-detail").textContent(), /Home 语音已检查 5 条/);
    assert.equal(await page.locator("[data-memory-view]").count(), 3, `${viewport.name}: expected three memory tabs`);
    assert.equal(await page.locator(".memory-markdown-file").count(), 3, `${viewport.name}: expected Core, Now and Topic documents`);
    await page.screenshot({ path: `/tmp/memory-system-${viewport.name}-personal.png`, fullPage: true });
    await page.click('[data-memory-view="detail"]');
    await page.waitForSelector(".memory-markdown-file");
    assert.match(await page.locator(".memory-markdown-file summary").first().textContent(), /agent-terminal-web/);
    await page.screenshot({ path: `/tmp/memory-system-${viewport.name}-projects.png`, fullPage: true });
    await page.click('[data-memory-view="changes"]');
    await page.waitForSelector(".memory-change-card");
    const nativeAudit = page.locator(".memory-change-card").filter({ hasText: "Codex 原生记忆" });
    assert.equal(await nativeAudit.count(), 1, `${viewport.name}: expected one native memory audit`);
    assert.match(await nativeAudit.textContent(), /已检查/);
    assert.equal(await nativeAudit.locator("button").count(), 0, `${viewport.name}: native audits must be read-only`);
    await nativeAudit.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/memory-system-${viewport.name}-native-review.png`, fullPage: true });
    const geometry = await page.evaluate(() => {
      const dialog = document.querySelector("#memory-dialog");
      const box = dialog.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        contentOverflow: document.querySelector("#memory-content").scrollWidth - document.querySelector("#memory-content").clientWidth,
      };
    });
    assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewportWidth + 1, `${viewport.name}: dialog overflows horizontally`);
    assert.ok(geometry.top >= 0 && geometry.bottom <= geometry.viewportHeight + 1, `${viewport.name}: dialog overflows vertically`);
    assert.ok(geometry.contentOverflow <= 1, `${viewport.name}: change cards overflow horizontally`);
    await page.screenshot({ path: `/tmp/memory-system-${viewport.name}.png`, fullPage: true });
    await page.close();
  }
  console.log("Memory UI desktop and mobile geometry passed.");
} finally {
  await browser.close();
}

function memoryPayload(view) {
  const changes = [
    {
      id: "change-update",
      targetType: "personal_memory",
      targetPath: "Core.md",
      entryId: "answer-style",
      action: "update",
      status: "pending",
      before: "喜欢简短回答。",
      after: { text: "喜欢具体、有依据并分析利弊的回答。", category: "交流偏好" },
      rationale: "用户在新 Session 中明确补充了回答方式。",
      reviewReason: "",
      evidence: [{ threadId: "thread-1", title: "回答偏好", quote: "希望讨论时能够分析利弊" }],
      confidence: 0.91,
    },
    {
      id: "change-project",
      targetType: "project_rule",
      targetPath: "/home/ubuntu/workspace/tibetan-learning-tool/AGENTS.md",
      entryId: "tibetan-rule",
      action: "create",
      status: "pending",
      before: null,
      after: { category: "学习规则", text: "发音规则需要有可重复测试的验证方法。" },
      rationale: "同一类纠错在项目中反复出现。",
      reviewReason: "",
      evidence: [{ threadId: "thread-2", title: "藏语学习", quote: "每一次纠错完都要反思并更新方法论" }],
      confidence: 0.88,
    },
    {
      id: "native-review-one",
      targetType: "native_review",
      targetPath: "/home/ubuntu/.codex/memories",
      entryId: "native-review-abc",
      action: "review",
      status: "approved",
      before: null,
      after: { text: "已检查 3 个变化文件，没有需要新增的正式记忆。", assessment: "no_change" },
      rationale: "原生内容已存在于正式 Markdown，且没有新的可验证差异。",
      reviewReason: "",
      evidence: [{ threadId: "native:abc", title: "Codex 原生记忆", quote: "变化文件：raw_memories.md" }],
      confidence: 1,
    },
  ];
  const selected = view === "pending" || view === "changes" ? changes : view === "detail" ? changes.slice(1) : [];
  return {
    status: { enabled: true, sourceCount: 13 },
    document: { content: "" },
    personal: {
      counts: { pending: 0, confirmed: 18, total: 18 },
      entries: [],
      documents: view === "overview"
        ? [
            { kind: "core", fileName: "Core.md", title: "核心记忆", content: "# 核心记忆\n\n## 交流偏好\n\n- 喜欢具体、有依据并分析利弊的回答。" },
            { kind: "now", fileName: "Now.md", title: "当前关注", content: "# 当前关注\n\n- 正在完善跨 Session 记忆。" },
            { kind: "topic", fileName: "Career.md", title: "职业探索", content: "# 职业探索\n\n- 关注小而深的公司。" },
          ]
        : [],
      sources: [],
      projectCatalog: [],
      runtime: { initializedAt: "2026-07-21T00:00:00Z", status: "idle", usage: { days: {}, lastAlertedDay: "" }, lastRun: { scanned: 14, eligible: 0, processed: 0, homeCapturesReviewed: 5 } },
    },
    knowledge: {
      counts: { total: 29, pending: 2, auto_applied: 18, project_rule: 11 },
      changes: selected,
    },
    projectRules: {
      documents: view === "detail"
        ? [{ project: "agent-terminal-web", targetPath: "/home/ubuntu/workspace/agent-terminal-web/AGENTS.md", content: "# Agent Web rules\n\n- Keep approvals visible." }]
        : [],
    },
  };
}
