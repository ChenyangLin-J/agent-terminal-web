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
    await page.click('[data-memory-view="pending"]');
    await page.waitForSelector(".memory-change-card");
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
      evidence: [{ threadId: "thread-2", title: "藏语学习", quote: "每一次纠错完都要反思并更新方法论" }],
      confidence: 0.88,
    },
  ];
  const selected = view === "pending" || view === "changes" ? changes : view === "detail" ? changes.slice(1) : [];
  return {
    status: { enabled: true, sourceCount: 13 },
    document: { content: "" },
    personal: {
      counts: { pending: 0, confirmed: 18, total: 18 },
      entries: view === "overview"
        ? [{ id: "answer-style", status: "confirmed", scope: "global", category: "交流偏好", text: "喜欢具体、有依据并分析利弊的回答。", evidence: [], confidence: "high" }]
        : [],
      sources: [],
      projectCatalog: [],
      runtime: { initializedAt: "2026-07-21T00:00:00Z", status: "idle", usage: { days: {} }, lastRun: { processed: 1 } },
    },
    knowledge: {
      counts: { total: 29, pending: 2, auto_applied: 18, project_rule: 11 },
      changes: selected,
    },
  };
}
