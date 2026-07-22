import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { memoryCitationFromToolItem } from "../lib/memory-access-citations.js";

const memoryRoot = "/workspace/obsidian/MainVault/System/Memory";
const workspaceRoot = "/workspace";
const existing = new Set([
  `${memoryRoot}/Topics/Tibetan.md`,
  `${workspaceRoot}/tibetan-learning-tool/AGENTS.md`,
]);
const options = { memoryRoot, workspaceRoot, exists: (file) => existing.has(path.resolve(file)) };

test("tool citations record actually read topic and direct project rule documents", () => {
  const topic = memoryCitationFromToolItem({
    type: "dynamicToolCall",
    status: "completed",
    arguments: `const r = await tools.exec_command({cmd:"sed -n '1,220p' ${memoryRoot}/Topics/Tibetan.md",workdir:"/workspace"});`,
  }, options);
  assert.deepEqual(topic.entries.map((entry) => entry.path), [`${memoryRoot}/Topics/Tibetan.md`]);

  const project = memoryCitationFromToolItem({
    type: "dynamicToolCall",
    status: "completed",
    arguments: `const r = await tools.exec_command({cmd:"sed -n '1,260p' AGENTS.md",workdir:"/workspace/tibetan-learning-tool"});`,
  }, options);
  assert.deepEqual(project.entries.map((entry) => entry.path), [`${workspaceRoot}/tibetan-learning-tool/AGENTS.md`]);

  const command = memoryCitationFromToolItem({
    type: "commandExecution",
    status: "completed",
    command: `sed -n '1,220p' ${memoryRoot}/Topics/Tibetan.md`,
    cwd: "/workspace",
  }, options);
  assert.deepEqual(command.entries.map((entry) => entry.path), [`${memoryRoot}/Topics/Tibetan.md`]);
});

test("tool citations ignore mere path discovery, failed reads and unrelated Markdown", () => {
  assert.equal(memoryCitationFromToolItem({ arguments: "find /workspace -name AGENTS.md -print" }, options), null);
  assert.equal(memoryCitationFromToolItem({ status: "failed", arguments: `cat ${memoryRoot}/Topics/Tibetan.md` }, options), null);
  assert.equal(memoryCitationFromToolItem({ status: "completed", arguments: "cat /workspace/project/README.md" }, options), null);
  assert.equal(memoryCitationFromToolItem({
    type: "dynamicToolCall",
    status: "completed",
    arguments: `const patch = "add an example containing sed ${memoryRoot}/Topics/Tibetan.md"; await tools.apply_patch(patch);`,
  }, options), null);
});
