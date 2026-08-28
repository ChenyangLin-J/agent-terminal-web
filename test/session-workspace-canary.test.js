import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

test("the Platform SessionWorkspace canary renders and emits host actions", async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  await page.setContent('<main id="session-workspace-core" class="session-workspace-core" style="height:100vh"></main>');
  await page.addStyleTag({ path: fileURLToPath(new URL("../public/session-list-core.css", import.meta.url)) });
  await page.addStyleTag({ path: fileURLToPath(new URL("../public/session-list-host.css", import.meta.url)) });
  await page.addScriptTag({
    path: fileURLToPath(new URL("../public/session-list-core.js", import.meta.url)),
  });

  await page.evaluate(() => {
    window.__workspaceActions = [];
    window.addEventListener("agent-session-workspace-action", (event) => {
      const detail = event.detail || {};
      window.__workspaceActions.push({
        type: detail.type,
        submission: detail.submission,
        href: detail.href,
      });
      detail.resolve?.([]);
    });
    window.__workspaceSnapshot = {
      attachmentPolicy: { maxCount: 5, maxBytes: 1024 * 1024 },
      documentPreview: null,
      features: { attachments: "visible", steer: true, subagents: "hidden", technicalDetails: true },
      labels: { back: "中控", composerPlaceholder: "继续处理…" },
      session: {
        sessionId: "canary-session",
        title: "Canary Session",
        contextLabel: "Personal · agent-terminal-web",
        status: "idle",
        statusLabel: "当前无任务",
        messages: [
          { id: "user-1", role: "user", content: "检查新版 UI", turnId: "turn-1" },
          { id: "assistant-1", role: "assistant", phase: "answer", content: "已经接入。", turnId: "turn-1" },
        ],
        technicalItems: [
          { id: "tool-1", title: "读取代码", detail: "public/app.js", status: "completed", turnId: "turn-1" },
        ],
        executionProfile: { label: "完全访问 · Agent Terminal Runtime" },
        models: [],
      },
    };
    window.AgentSessionWorkspace.render(document.querySelector("#session-workspace-core"), window.__workspaceSnapshot);
  });

  await page.getByRole("heading", { name: "Canary Session" }).waitFor();
  assert.equal(await page.getByText("已经接入。").count(), 1);
  await page.getByText("本轮执行详情").click();
  assert.equal(await page.getByText("读取代码").count(), 1);

  await page.getByRole("textbox", { name: "继续处理…" }).fill("继续测试附件和消息");
  await page.getByRole("button", { name: "发送" }).click();
  await page.waitForFunction(() => window.__workspaceActions.some((action) => action.type === "submit"));
  const actions = await page.evaluate(() => window.__workspaceActions);
  assert.ok(actions.some((action) => action.type === "draft-change"));
  assert.ok(actions.some((action) => action.type === "submit" && action.submission.prompt === "继续测试附件和消息"));

  await page.evaluate(() => {
    window.__workspaceSnapshot.documentPreview = {
      name: "app.js",
      path: "/workspace/app.js:2",
      format: "code",
      content: "const first = true;\nconst highlighted = true;\n",
      line: 2,
      openUrl: "/open/local?path=app.js",
    };
    window.AgentSessionWorkspace.render(document.querySelector("#session-workspace-core"), window.__workspaceSnapshot);
  });
  await page.getByRole("dialog", { name: "文件预览：app.js" }).waitFor();
  assert.equal(await page.locator(".cwu-document-code-line.is-highlighted").textContent(), "2const highlighted = true;");
  await page.getByRole("button", { name: "关闭文件预览" }).click();
  await page.waitForFunction(() => window.__workspaceActions.some((action) => action.type === "close-document"));

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await page.getByRole("button", { name: "列表" }).isVisible(), true);
});
