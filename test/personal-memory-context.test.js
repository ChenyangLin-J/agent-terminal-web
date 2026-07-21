import assert from "node:assert/strict";
import test from "node:test";
import { buildPersonalMemoryContext, resolvePersonalMemoryProjects } from "../lib/personal-memory-context.js";

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
