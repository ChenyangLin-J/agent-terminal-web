import assert from "node:assert/strict";
import test from "node:test";
import { buildPersonalMemoryContext } from "../lib/personal-memory-context.js";

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
