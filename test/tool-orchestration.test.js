import assert from "node:assert/strict";
import test from "node:test";
import { parseOrchestratedToolCalls } from "../lib/tool-orchestration.js";

test("exec orchestration is parsed into its nested structured tool calls", () => {
  const calls = parseOrchestratedToolCalls(`
    const results = await Promise.all([
      tools.exec_command({ cmd: "git status --short", workdir: "/workspace/project" }),
      tools.view_image({ path: "/tmp/preview.png", detail: "original" }),
    ]);
    for (const result of results) text(result.output);
  `);

  assert.deepEqual(calls, [
    {
      name: "exec_command",
      args: { cmd: "git status --short", workdir: "/workspace/project" },
      rawArguments: '{ cmd: "git status --short", workdir: "/workspace/project" }',
    },
    {
      name: "view_image",
      args: { path: "/tmp/preview.png", detail: "original" },
      rawArguments: '{ path: "/tmp/preview.png", detail: "original" }',
    },
  ]);
});

test("invalid orchestration source safely returns no calls", () => {
  assert.deepEqual(parseOrchestratedToolCalls("const broken ="), []);
});
