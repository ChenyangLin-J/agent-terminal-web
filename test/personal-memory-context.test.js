import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildPersonalMemoryContext,
  personalMemoryContextForPrompt,
  resolvePersonalMemoryProjects,
} from "../lib/personal-memory-context.js";

const store = {
  entries: [
    {
      id: "global-style",
      status: "confirmed",
      scope: "global",
      category: "交流偏好",
      text: "回答要具体。",
      sensitive: false,
      evidence: [{ threadId: "thread-one" }],
    },
    {
      id: "global-health",
      status: "confirmed",
      scope: "global",
      category: "健康与护理",
      text: "正在接受皮肤治疗。",
      sensitive: true,
    },
    {
      id: "project-agent",
      status: "confirmed",
      scope: "project",
      project: "agent-terminal-web",
      aliases: ["记忆系统"],
      category: "项目目标",
      text: "Agent 是主要沟通入口。",
      sensitive: false,
    },
    {
      id: "project-tibetan",
      status: "confirmed",
      scope: "project",
      project: "tibetan-learning-tool",
      aliases: ["藏语"],
      category: "项目规则",
      text: "按 Unit 组织课程。",
      sensitive: false,
    },
  ],
};

test("runtime progressive context injects Core and Now without bulk-loading Topics", async (t) => {
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "progressive-context-"));
  t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
  const memoryRoot = path.join(codexHome, "memory-markdown");
  await fs.mkdir(path.join(memoryRoot, "Topics"), { recursive: true });
  await fs.writeFile(path.join(memoryRoot, "Core.md"), '<!-- memory-file: {"kind":"core","title":"核心","description":"测试"} -->\n# 核心\n\n## 偏好\n\n- 喜欢具体回答。 ^core-style\n');
  await fs.writeFile(path.join(memoryRoot, "Now.md"), '<!-- memory-file: {"kind":"now","title":"当前","description":"测试"} -->\n# 当前\n\n## 当前重点\n\n- 正在搭建记忆系统。 ^now-memory\n');
  await fs.writeFile(path.join(memoryRoot, "Topics", "Health.md"), '<!-- memory-file: {"kind":"topic","slug":"Health","title":"健康","description":"健康","readWhen":"讨论健康时","sensitive":true} -->\n# 健康\n\n## 健康\n\n- 不应默认读取。 ^health-private\n');
  const context = await personalMemoryContextForPrompt(codexHome, { prompt: "继续做记忆界面" });
  assert.match(context.value, /喜欢具体回答/);
  assert.match(context.value, /正在搭建记忆系统/);
  assert.doesNotMatch(context.value, /不应默认读取/);
  assert.deepEqual(context.citation.entries.map((entry) => path.basename(entry.path)), ["Core.md", "Now.md"]);
});

test("memory context always reads global memory and only the active project", () => {
  const context = buildPersonalMemoryContext(store, {
    cwd: "/home/ubuntu/workspace/agent-terminal-web",
    workspaceRoot: "/home/ubuntu/workspace",
    prompt: "继续做读取层",
    storePath: "/home/ubuntu/.codex/personal-memories/store.json",
  });
  assert.match(context.value, /global-style/);
  assert.match(context.value, /project-agent/);
  assert.doesNotMatch(context.value, /project-tibetan/);
  assert.doesNotMatch(context.value, /global-health/);
  assert.deepEqual(context.citation.threadIds, ["thread-one"]);
});

test("project aliases and topic relevance opt sensitive memory in explicitly", () => {
  const context = buildPersonalMemoryContext(store, {
    cwd: "/home/ubuntu/workspace",
    workspaceRoot: "/home/ubuntu/workspace",
    prompt: "藏语工具和皮肤健康护理分别有什么要注意的？",
  });
  assert.match(context.value, /project-tibetan/);
  assert.match(context.value, /global-health/);
  assert.doesNotMatch(context.value, /project-agent/);
});

test("one prompt can activate multiple semantic projects while workspace stays only a file scope", () => {
  const context = buildPersonalMemoryContext(store, {
    cwd: "/home/ubuntu/workspace",
    workspaceRoot: "/home/ubuntu/workspace",
    prompt: "把藏语工具的内容接到 Agent 记忆系统里",
  });
  assert.deepEqual(context.projects, ["agent-terminal-web", "tibetan-learning-tool"]);
  assert.equal(context.projectSource, "prompt");
  assert.match(context.value, /project-agent/);
  assert.match(context.value, /project-tibetan/);
});

test("automatic routing retains projects for follow-ups and a new explicit topic replaces them", () => {
  const retained = resolvePersonalMemoryProjects(store, {
    cwd: "/home/ubuntu/workspace",
    workspaceRoot: "/home/ubuntu/workspace",
    prompt: "继续完成刚才那一步",
    projects: ["tibetan-learning-tool"],
  });
  assert.deepEqual(retained, { mode: "auto", projects: ["tibetan-learning-tool"], source: "retained" });

  const switched = resolvePersonalMemoryProjects(store, {
    cwd: "/home/ubuntu/workspace",
    workspaceRoot: "/home/ubuntu/workspace",
    prompt: "现在改记忆系统的按钮",
    projects: ["tibetan-learning-tool"],
  });
  assert.deepEqual(switched, { mode: "auto", projects: ["agent-terminal-web"], source: "prompt" });
});

test("manual routing supports multiple projects and an empty global-only selection", () => {
  assert.deepEqual(
    resolvePersonalMemoryProjects(store, {
      mode: "manual",
      projects: ["agent-terminal-web", "tibetan-learning-tool"],
    }),
    {
      mode: "manual",
      projects: ["agent-terminal-web", "tibetan-learning-tool"],
      source: "manual",
    },
  );
  assert.deepEqual(resolvePersonalMemoryProjects(store, { mode: "manual", projects: [] }), {
    mode: "manual",
    projects: [],
    source: "manual",
  });
});

test("known workspace projects can route before their first memory, but workspace itself cannot", () => {
  assert.deepEqual(
    resolvePersonalMemoryProjects({ entries: [] }, {
      cwd: "/home/ubuntu/workspace/shared-web",
      workspaceRoot: "/home/ubuntu/workspace",
      knownProjects: ["shared-web", "workspace"],
    }),
    { mode: "auto", projects: ["shared-web"], source: "cwd" },
  );
  assert.deepEqual(
    resolvePersonalMemoryProjects({ entries: [] }, {
      cwd: "/home/ubuntu/workspace",
      workspaceRoot: "/home/ubuntu/workspace",
      prompt: "继续处理 workspace",
      knownProjects: ["shared-web", "workspace"],
    }),
    { mode: "auto", projects: [], source: "global" },
  );
});
