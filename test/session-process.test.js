import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSessionProcessFromJsonl,
  warmSessionProcessIndex,
} from "../lib/session-process.js";

const turnId = "019f8d05-7a2d-7f43-a52c-caa9f5dcd1cf";

test("historical process details are extracted for one requested turn", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-process-"));
  const file = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const meta = { turn_id: turnId };
  const records = [
    response("message", {
      id: "message-1",
      role: "assistant",
      phase: "commentary",
      content: [{ type: "output_text", text: "先检查实际页面。" }],
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("function_call", {
      id: "call-item-1",
      name: "exec_command",
      call_id: "call-1",
      arguments: JSON.stringify({ cmd: "npm test", workdir: "/workspace/project" }),
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("function_call_output", {
      call_id: "call-1",
      output: "Process exited with code 0\nAll tests passed",
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("function_call", {
      id: "call-item-2",
      name: "view_image",
      call_id: "call-2",
      arguments: JSON.stringify({ path: "/tmp/preview.png" }),
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("function_call_output", {
      call_id: "call-2",
      output: [{ type: "input_image", image_url: "data:image/png;base64,large" }],
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("function_call", {
      id: "other-call",
      name: "exec_command",
      call_id: "other",
      arguments: JSON.stringify({ cmd: "ignored" }),
      internal_chat_message_metadata_passthrough: { turn_id: "other-turn" },
    }),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const items = await extractSessionProcessFromJsonl(file, turnId);

  assert.deepEqual(items.map((item) => item.type), ["assistant", "command", "tool"]);
  assert.equal(items[0].text, "先检查实际页面。");
  assert.equal(items[1].text, "npm test");
  assert.equal(items[1].detail, "目录：/workspace/project");
  assert.match(items[1].output, /All tests passed/);
  assert.equal(items[2].label, "查看图片");
  assert.equal(items[2].text, "/tmp/preview.png");
  assert.equal(items[2].output, undefined);
  assert.ok(items.every((item) => item.historical && item.turnId === turnId));
});

test("older process details stream from outside the recent tail", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-process-old-"));
  const file = path.join(directory, "rollout.jsonl");
  const indexFile = path.join(directory, "index", "turns.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const record = response("message", {
    id: "message-old",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "较早的处理过程" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-old" },
  });
  const filler = JSON.stringify({ type: "event_msg", payload: { text: "x".repeat(1024) } });
  await fs.writeFile(file, `${JSON.stringify(record)}\n${`${filler}\n`.repeat(80)}`);

  const index = await warmSessionProcessIndex(file, indexFile);
  const items = await extractSessionProcessFromJsonl(file, "turn-old", {
    maxBytes: 64 * 1024,
    indexFile,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].text, "较早的处理过程");
  assert.ok(index.turns["turn-old"][1] < index.sourceSize);
  assert.deepEqual(JSON.parse(await fs.readFile(indexFile, "utf8")).turns["turn-old"], index.turns["turn-old"]);
});

test("the process offset index scans only appended JSONL content on refresh", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-process-append-"));
  const file = path.join(directory, "rollout.jsonl");
  const indexFile = path.join(directory, "index.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = response("message", {
    id: "message-first",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "第一轮" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-first" },
  });
  await fs.writeFile(file, `${JSON.stringify(first)}\n`);
  const initial = await warmSessionProcessIndex(file, indexFile);

  const second = response("message", {
    id: "message-second",
    role: "assistant",
    phase: "commentary",
    content: [{ type: "output_text", text: "新增一轮" }],
    internal_chat_message_metadata_passthrough: { turn_id: "turn-second" },
  });
  await fs.appendFile(file, `${JSON.stringify(second)}\n`);
  const updated = await warmSessionProcessIndex(file, indexFile);

  assert.equal(updated.turns["turn-first"][0], initial.turns["turn-first"][0]);
  assert.ok(updated.turns["turn-second"][0] >= initial.sourceSize);
  assert.equal(updated.sourceSize, (await fs.stat(file)).size);
  const items = await extractSessionProcessFromJsonl(file, "turn-first", {
    maxBytes: 64 * 1024,
    indexFile,
  });
  assert.equal(items[0].text, "第一轮");
});

test("exec orchestration restores nested commands instead of the exec wrapper", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-process-exec-"));
  const file = path.join(directory, "rollout.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const meta = { turn_id: "turn-exec" };
  const records = [
    response("custom_tool_call", {
      id: "exec-item",
      name: "exec",
      call_id: "exec-call",
      input: `const results = await Promise.all([
        tools.exec_command({cmd:"/bin/bash -lc 'git status --short'",workdir:"/workspace/project"}),
        tools.view_image({path:"/tmp/preview.png",detail:"original"})
      ]); for (const result of results) text(result.output);`,
      internal_chat_message_metadata_passthrough: meta,
    }),
    response("custom_tool_call_output", {
      call_id: "exec-call",
      output: [
        { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "input_text", text: " M public/app.js\n" },
        { type: "input_text", text: "" },
      ],
      internal_chat_message_metadata_passthrough: meta,
    }),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const items = await extractSessionProcessFromJsonl(file, "turn-exec");

  assert.deepEqual(items.map((item) => item.type), ["command", "tool"]);
  assert.equal(items[0].text, "git status --short");
  assert.equal(items[0].output, "M public/app.js");
  assert.equal(items[1].label, "查看图片");
  assert.equal(items[1].text, "/tmp/preview.png");
  assert.equal(items.some((item) => item.text === "exec"), false);
});

test("historical process details load only when a restored group is expanded", async () => {
  const [server] = await Promise.all([
fs.readFile(new URL("../server.js", import.meta.url), "utf8")
]);

  assert.match(server, /app\.get\("\/api\/session-process\/:sessionId\/:turnId"/);
  assert.match(server, /\(!isRestoredTurn && !isCodexTurnId\(turnId\)\)/);
  assert.match(server, /session\.historyProcessCache \|\|= new Map\(\)/);
  assert.match(server, /indexFile: sessionProcessIndexFile\(session\.sessionId\)/);
  assert.match(server, /scheduleSessionProcessIndexWarm\(session\)/);
  assert.match(server, /logAgentEvent\("session-process-load"/);

});

function response(type, payload) {
  return {
    timestamp: "2026-07-23T03:29:50.000Z",
    type: "response_item",
    payload: { type, ...payload },
  };
}
