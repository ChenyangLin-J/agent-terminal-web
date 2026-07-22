import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectMemorySections,
  readCodexMemoryStatus,
  readCodexMemoryView,
} from "../lib/codex-memories.js";
import {
  applyPersonalMemoryProposals,
  deletePersonalMemoryEntry,
  readPersonalMemoryView,
  updatePersonalMemoryEntry,
} from "../lib/personal-memories.js";

test("Codex memory status reflects config and generated files", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    "[features]\nmemories = true\n\n[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n",
  );
  await fs.writeFile(path.join(codexHome, "memories", "memory_summary.md"), "# Overview\nUseful profile\n");

  const status = await readCodexMemoryStatus(codexHome);
  assert.equal(status.enabled, true);
  assert.equal(status.generateMemories, true);
  assert.equal(status.useMemories, true);
  assert.equal(status.ready, true);
  assert.equal(status.documents.overview.available, true);
  assert.equal(status.documents.detail.available, false);
});

test("all automatic personal-memory proposals remain pending until approval", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  await fs.mkdir(path.join(codexHome, "personal-memories"), { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "personal-memories", "store.json"),
    `${JSON.stringify({
      version: 2,
      entries: [
        {
          id: "global-answer-style",
          status: "confirmed",
          scope: "global",
          category: "交流偏好",
          text: "喜欢具体的回答。",
          confidence: "high",
        },
      ],
      sources: [],
      tombstones: [],
    })}\n`,
  );

  const source = { threadId: "thread-automatic-memory", title: "记忆偏好", source: "vscode" };
  const created = await applyPersonalMemoryProposals(
    codexHome,
    [
      {
        action: "create",
        scope: "global",
        category: "学习偏好",
        text: "学习新语言时不希望设置 KPI。",
        confidence: 0.92,
        explicit: true,
        conflict: false,
        sensitive: false,
        evidenceQuote: "我不希望设置 KPI",
      },
      {
        action: "create",
        scope: "global",
        category: "健康与护理",
        text: "正在服用处方药。",
        confidence: 0.95,
        explicit: true,
        conflict: false,
        sensitive: true,
        evidenceQuote: "正在服用处方药",
      },
    ],
    source,
  );
  assert.deepEqual(created.map((item) => item.status), ["pending", "pending"]);

  const [pendingUpdate] = await applyPersonalMemoryProposals(
    codexHome,
    [
      {
        action: "update",
        targetId: "global-answer-style",
        scope: "global",
        category: "交流偏好",
        text: "喜欢具体、有依据并分析利弊的回答。",
        confidence: 0.8,
        explicit: true,
        conflict: true,
        sensitive: false,
        evidenceQuote: "希望分析利弊",
      },
    ],
    source,
  );
  assert.equal(pendingUpdate.action, "pending-update");

  const [pendingRetire] = await applyPersonalMemoryProposals(
    codexHome,
    [{
      action: "retire",
      targetId: "global-answer-style",
      scope: "global",
      category: "交流偏好",
      text: "不再保留这条回答偏好。",
      confidence: 0.99,
      explicit: true,
      conflict: false,
      sensitive: false,
      evidenceQuote: "删除这条记忆",
    }],
    source,
  );
  assert.equal(pendingRetire.action, "pending-retire");

  await updatePersonalMemoryEntry(codexHome, pendingUpdate.id, { status: "confirmed" });
  const view = await readPersonalMemoryView(codexHome, { view: "overview" });
  assert.match(view.entries.find((entry) => entry.id === "global-answer-style").text, /分析利弊/);
  assert.equal(view.entries.find((entry) => entry.id === "global-answer-style").memoryLocation, "Core");
  assert.deepEqual(view.documents.map((document) => document.fileName), ["Core.md", "Now.md"]);
  assert.equal(view.counts.pending, 3);

  const audit = await fs.readFile(path.join(codexHome, "personal-memories", "history.jsonl"), "utf8");
  assert.match(audit, /approve-update/);
});

test("project memory view keeps matching project sections separate", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const detail = [
    "# Memory",
    "General preference",
    "## Tibetan learning tool",
    "Project: /home/ubuntu/workspace/tibetan-learning-tool",
    "Always update the audio segmentation method after a correction.",
    "## Personal site",
    "Project: /home/ubuntu/workspace/personal-site",
    "Thoughts are published here.",
  ].join("\n");
  await fs.writeFile(path.join(codexHome, "memories", "MEMORY.md"), detail);

  const result = await readCodexMemoryView(codexHome, {
    view: "detail",
    project: "/home/ubuntu/workspace/tibetan-learning-tool",
  });
  assert.match(result.document.content, /audio segmentation/);
  assert.doesNotMatch(result.document.content, /Thoughts are published/);

  const combined = await readCodexMemoryView(codexHome, {
    view: "detail",
    projects: JSON.stringify(["tibetan-learning-tool", "personal-site"]),
  });
  assert.match(combined.document.content, /audio segmentation/);
  assert.match(combined.document.content, /Thoughts are published/);
  assert.deepEqual(combined.document.projects, ["tibetan-learning-tool", "personal-site"]);
});

test("personal project memory view accepts multiple semantic projects", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  await fs.mkdir(path.join(codexHome, "personal-memories"), { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "personal-memories", "store.json"),
    `${JSON.stringify({
      version: 2,
      entries: [
        { id: "project-agent-one", status: "confirmed", scope: "project", project: "agent-terminal-web", category: "目标", text: "Agent 目标。" },
        { id: "project-home-one", status: "confirmed", scope: "project", project: "home-portal", category: "目标", text: "Home 目标。" },
        { id: "project-site-one", status: "confirmed", scope: "project", project: "personal-site", category: "目标", text: "Site 目标。" },
      ],
      sources: [],
      tombstones: [],
    })}\n`,
  );

  const view = await readPersonalMemoryView(codexHome, {
    view: "detail",
    projects: JSON.stringify(["agent-terminal-web", "home-portal"]),
  });
  assert.deepEqual(view.selectedProjects, ["agent-terminal-web", "home-portal"]);
  assert.deepEqual(view.entries.map((entry) => entry.id), ["project-agent-one", "project-home-one"]);
  assert.deepEqual(view.projectCatalog.map((item) => item.project), ["agent-terminal-web", "home-portal", "personal-site"]);
});

test("memory source reads are restricted to generated Markdown summaries", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const sourceRoot = path.join(codexHome, "memories", "rollout_summaries");
  await fs.writeFile(path.join(sourceRoot, "session-one.md"), "# Session one\nEvidence\n");

  const listed = await readCodexMemoryView(codexHome, { view: "sources" });
  assert.deepEqual(listed.sources.map((source) => source.name), ["session-one.md"]);

  const selected = await readCodexMemoryView(codexHome, { view: "sources", source: "session-one.md" });
  assert.match(selected.selected.content, /Evidence/);

  const escaped = await readCodexMemoryView(codexHome, { view: "sources", source: "../config.toml" });
  assert.equal(escaped.selected, null);
});

test("project memory explains when no generated section matches", () => {
  const result = projectMemorySections("# Memory\nOnly global context", "personal-site");
  assert.match(result, /还没有可识别的长期记忆/);
  assert.match(result, /personal-site/);
});

test("Agent Web exposes memory review views and authenticated APIs", async () => {
  const [server, app, page, styles] = await Promise.all([
    fs.readFile(new URL("../server.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/agent-memories.css", import.meta.url), "utf8"),
  ]);
  assert.match(server, /app\.use\("\/api", requireAuth\)[\s\S]*app\.get\("\/api\/memories\/status"/);
  assert.match(server, /app\.get\("\/api\/memories"/);
  assert.match(server, /app\.patch\("\/api\/memories\/:id"/);
  assert.match(server, /app\.delete\("\/api\/memories\/:id"/);
  assert.match(server, /app\.patch\("\/api\/knowledge-changes\/:id"/);
  assert.match(page, /id="open-memories"/);
  assert.match(page, /id="app-session-memories"/);
  assert.match(page, /id="memory-project-routing"/);
  assert.doesNotMatch(page, /id="open-memories" class="hidden"/);
  assert.match(page, /Memory System · 审批后写入/);
  assert.match(page, /data-memory-trigger-status/);
  assert.match(page, /data-memory-view="overview"/);
  assert.match(page, /data-memory-view="detail"/);
  assert.match(page, /data-memory-view="changes"/);
  assert.doesNotMatch(page, /data-memory-view="pending"|data-memory-view="sources"/);
  assert.match(page, /agent-memories\.js\?v=/);
  const memoryUi = await fs.readFile(new URL("../public/agent-memories.js", import.meta.url), "utf8");
  assert.match(memoryUi, /renderPersonalDocuments/);
  assert.match(memoryUi, /renderProjectRuleDocuments/);
  assert.doesNotMatch(memoryUi, /renderPersonalEntries|renderSources/);
  assert.match(memoryUi, /renderKnowledgeChanges/);
  assert.match(memoryUi, /refreshStatus/);
  assert.match(memoryUi, /待确认 \$\{pendingCount\}/);
  assert.match(memoryUi, /onProjectChange/);
  assert.match(memoryUi, /默认读取 Core 与 Now/);
  assert.match(memoryUi, /待审批变更置顶/);
  assert.match(memoryUi, /审批反馈/);
  assert.match(memoryUi, /今天模型整理/);
  assert.match(memoryUi, /Turn 完成 1 分钟后整理/);
  assert.match(memoryUi, /没有可整理的已完成内容/);
  assert.match(memoryUi, /正在处理这条变更/);
  assert.match(memoryUi, /没有改写目标/);
  assert.match(memoryUi, /workspace 一级子目录的 AGENTS\.md/);
  assert.match(memoryUi, /showInlineConfirmation/);
  assert.match(memoryUi, /showInlineEditor/);
  assert.doesNotMatch(memoryUi, /global\.(?:confirm|prompt|alert)/);
  assert.match(memoryUi, /await loadView\(\);[\s\S]*refreshStatus/);
  assert.doesNotMatch(memoryUi, /批准后会立即写入/);
  assert.match(styles, /\.memory-action-feedback\.memory-message-error/);
  assert.match(styles, /\.memory-inline-confirmation/);
  assert.match(styles, /\.memory-inline-textarea/);
  assert.match(styles, /\.memory-markdown-file/);
  assert.match(page, /id="memory-context">Core、Now 与按需 Topics/);
  assert.match(app, /name: "\/memories"/);
  assert.match(app, /查看个人记忆、项目规则与审批记录/);
  assert.match(app, /AgentMemories\?\.open/);
  assert.match(app, /type: "set-memory-projects"/);
  assert.match(styles, /\.memory-dialog/);
});

test("personal memories remain pending until confirmed and can be edited or deleted", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  await fs.mkdir(path.join(codexHome, "personal-memories"), { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "personal-memories", "store.json"),
    `${JSON.stringify({
      version: 1,
      entries: [
        {
          id: "global-answer-style",
          status: "pending",
          scope: "global",
          category: "交流偏好",
          text: "给具体、有依据的回答。",
          confidence: "high",
          evidence: [{ threadId: "thread-1", title: "Memory", quote: "具体、实用、有依据" }],
        },
        {
          id: "project-tibetan-audio",
          status: "confirmed",
          scope: "project",
          project: "tibetan-learning-tool",
          category: "项目决策",
          text: "使用五度标记法。",
        },
      ],
      sources: [{ threadId: "thread-1", title: "Memory", decision: "included", archived: false }],
    })}\n`,
  );

  const pending = await readPersonalMemoryView(codexHome, { view: "pending" });
  assert.deepEqual(pending.entries.map((entry) => entry.id), ["global-answer-style"]);
  assert.equal(pending.counts.pending, 1);

  const detail = await readPersonalMemoryView(codexHome, {
    view: "detail",
    project: "/home/ubuntu/workspace/tibetan-learning-tool",
  });
  assert.deepEqual(detail.entries.map((entry) => entry.id), ["project-tibetan-audio"]);

  await updatePersonalMemoryEntry(codexHome, "global-answer-style", {
    status: "confirmed",
    text: "给具体、实用且有依据的回答。",
  });
  const overview = await readPersonalMemoryView(codexHome, { view: "overview" });
  assert.equal(overview.entries[0].text, "给具体、实用且有依据的回答。");

  await deletePersonalMemoryEntry(codexHome, "global-answer-style");
  const afterDelete = await readPersonalMemoryView(codexHome, { view: "overview" });
  assert.equal(afterDelete.entries.length, 0);
});

async function temporaryCodexHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memories-"));
  await fs.mkdir(path.join(root, "memories", "rollout_summaries"), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
