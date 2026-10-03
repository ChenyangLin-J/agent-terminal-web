import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appServerConversationFromTurnPage,
  extractSessionConversationFromJsonl,
  extractSessionPreviewFromJsonl,
  extractSessionTokenUsageFromJsonl,
  readAppServerSessionConversation,
  readSessionPreviews,
  saveSessionPreview,
} from "../lib/session-preview.js";

test("extracts the latest completed answer and its preceding user request from a JSONL tail", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-preview-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const records = [
    message("user", "old request", "2026-07-17T00:00:00.000Z"),
    message("assistant", "old answer", "2026-07-17T00:01:00.000Z", "final_answer"),
    message("user", "latest request", "2026-07-17T00:02:00.000Z"),
    message("assistant", "working note", "2026-07-17T00:03:00.000Z", "commentary"),
    message("assistant", "latest answer", "2026-07-17T00:04:00.000Z", "final_answer"),
    message("user", "a newer unfinished request", "2026-07-17T00:05:00.000Z"),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const preview = await extractSessionPreviewFromJsonl(file, { maxBytes: 128 * 1024 });
  assert.equal(preview.prompt, "latest request");
  assert.equal(preview.result, "latest answer");
  assert.equal(preview.completedAt, "2026-07-17T00:04:00.000Z");
});

test("extracts the latest context and cumulative token usage from a JSONL tail", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-tokens-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const record = {
    timestamp: "2026-07-17T00:05:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1200,
        },
        last_token_usage: {
          input_tokens: 400,
          cached_input_tokens: 300,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 420,
        },
        model_context_window: 258400,
      },
    },
  };
  await fs.writeFile(file, `${JSON.stringify(record)}\n`);

  const usage = await extractSessionTokenUsageFromJsonl(file);
  assert.equal(usage.total.totalTokens, 1200);
  assert.equal(usage.last.totalTokens, 420);
  assert.equal(usage.modelContextWindow, 258400);
});

test("extracts recent user and assistant conversation turns directly from disk", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-conversation-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const records = [];
  for (let index = 1; index <= 12; index += 1) {
    records.push({
      timestamp: `2026-07-17T00:${String(index).padStart(2, "0")}:00.000Z`,
      type: "event_msg",
      payload: { type: "user_message", message: `request ${index}` },
    });
    const turnId = `019f0000-0000-7000-8000-${String(index).padStart(12, "0")}`;
    records.push(
      message(
        "assistant",
        `progress ${index}`,
        `2026-07-17T00:${String(index).padStart(2, "0")}:10.000Z`,
        "commentary",
        turnId,
      ),
    );
    records.push(
      message(
        "assistant",
        `answer ${index}`,
        `2026-07-17T00:${String(index).padStart(2, "0")}:20.000Z`,
        "final_answer",
        turnId,
      ),
    );
  }
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const conversation = await extractSessionConversationFromJsonl(file, { limit: 10 });
  assert.equal(conversation.turns.length, 10);
  assert.equal(conversation.hasEarlier, true);
  assert.equal(conversation.nextCursor, "10");
  assert.equal(conversation.turns[0].user, "request 3");
  assert.equal(conversation.turns[0].id, "019f0000-0000-7000-8000-000000000003");
  assert.deepEqual(
    conversation.turns.at(-1).assistant.map((item) => item.phase),
    ["commentary", "final_answer"],
  );

  const earlier = await extractSessionConversationFromJsonl(file, { limit: 10, offset: 10 });
  assert.deepEqual(earlier.turns.map((turn) => turn.user), ["request 1", "request 2"]);
  assert.equal(earlier.hasEarlier, false);
  assert.equal(earlier.nextCursor, null);
});

test("paginates rollouts that store user messages as response items", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-response-item-history-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const records = [];
  for (let index = 1; index <= 3; index += 1) {
    records.push(message("user", `request ${index}`, `2026-07-17T00:0${index}:00.000Z`));
    records.push(message("assistant", `answer ${index}`, `2026-07-17T00:0${index}:10.000Z`, "final_answer"));
  }
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const recent = await extractSessionConversationFromJsonl(file, { limit: 2 });
  assert.deepEqual(recent.turns.map((turn) => turn.user), ["request 2", "request 3"]);
  assert.equal(recent.nextCursor, "2");
  const earlier = await extractSessionConversationFromJsonl(file, { limit: 2, offset: Number(recent.nextCursor) });
  assert.deepEqual(earlier.turns.map((turn) => turn.user), ["request 1"]);
  assert.deepEqual(earlier.turns[0].assistant.map((item) => item.text), ["answer 1"]);
  assert.equal(earlier.hasEarlier, false);
});

test("extracts a subagent conversation from task metadata when its rollout has no user_message event", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-conversation-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const records = [
    {
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "session_meta",
      payload: {
        thread_source: "subagent",
        agent_path: "/root/disk-preview",
        source: { subagent: { thread_spawn: { agent_path: "/root/disk-preview" } } },
      },
    },
    message("developer", "injected developer instructions", "2026-07-17T00:00:01.000Z"),
    message("user", "injected environment context", "2026-07-17T00:00:02.000Z"),
    {
      timestamp: "2026-07-17T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "/root",
        recipient: "/root/disk-preview",
        internal_chat_message_metadata_passthrough: { turn_id: "subagent-turn" },
        content: [{
          type: "input_text",
          text: "Message Type: NEW_TASK\nTask name: /root/disk-preview\nSender: /root\nPayload:\nInspect the disk fallback.",
        }],
      },
    },
    message("assistant", "I will inspect it.", "2026-07-17T00:00:04.000Z", "commentary", "subagent-turn"),
    message("assistant", "Disk fallback is fixed.", "2026-07-17T00:00:05.000Z", "final_answer", "subagent-turn"),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const conversation = await extractSessionConversationFromJsonl(file);
  assert.equal(conversation.hasEarlier, false);
  assert.deepEqual(conversation.turns, [{
    id: "subagent-turn",
    user: "Delegated task: /root/disk-preview\n\nInspect the disk fallback.",
    startedAt: "2026-07-17T00:00:03.000Z",
    assistant: [
      { text: "I will inspect it.", phase: "commentary", completedAt: "2026-07-17T00:00:04.000Z" },
      { text: "Disk fallback is fixed.", phase: "final_answer", completedAt: "2026-07-17T00:00:05.000Z" },
    ],
  }]);
});

test("keeps separate disk turns for each subagent NEW_TASK", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-followup-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const task = (timestamp, turnId, name, body = "") => ({
    timestamp,
    type: "response_item",
    payload: {
      type: "agent_message",
      author: "/root",
      recipient: "/root/disk-preview",
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
      content: [
        { type: "input_text", text: `Message Type: NEW_TASK\nTask name: ${name}\nSender: /root\nPayload:\n${body}` },
        { type: "encrypted_content", encrypted_content: "opaque-task-payload" },
      ],
    },
  });
  const records = [
    {
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "session_meta",
      payload: { thread_source: "subagent", agent_path: "/root/disk-preview" },
    },
    message("developer", "injected developer instructions", "2026-07-17T00:00:01.000Z"),
    message("user", "injected environment context", "2026-07-17T00:00:02.000Z"),
    task("2026-07-17T00:00:03.000Z", "first-task", "/root/disk-preview", "Inspect the first task."),
    message("assistant", "First progress", "2026-07-17T00:00:04.000Z", "commentary", "first-task"),
    message("assistant", "First result", "2026-07-17T00:00:05.000Z", "final_answer", "first-task"),
    task("2026-07-17T00:00:06.000Z", "followup-task", "/root/disk-preview", ""),
    message("assistant", "Follow-up progress", "2026-07-17T00:00:07.000Z", "commentary", "followup-task"),
    message("assistant", "Follow-up result", "2026-07-17T00:00:08.000Z", "final_answer", "followup-task"),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const conversation = await extractSessionConversationFromJsonl(file);
  assert.deepEqual(conversation.turns.map((turn) => ({
    id: turn.id,
    user: turn.user,
    assistant: turn.assistant.map((item) => item.text),
  })), [
    {
      id: "first-task",
      user: "Delegated task: /root/disk-preview\n\nInspect the first task.",
      assistant: ["First progress", "First result"],
    },
    {
      id: "followup-task",
      user: "Delegated task: /root/disk-preview",
      assistant: ["Follow-up progress", "Follow-up result"],
    },
  ]);
});

test("reads subagent metadata from the file head when the conversation tail is large", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-subagent-long-tail-"));
  const file = path.join(directory, "rollout-session.jsonl");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const records = [
    {
      timestamp: "2026-07-17T00:00:00.000Z",
      type: "session_meta",
      payload: {
        thread_source: "subagent",
        source: { subagent: { thread_spawn: { agent_path: null, agent_nickname: "Helmholtz" } } },
      },
    },
    {
      timestamp: "2026-07-17T00:00:01.000Z",
      type: "response_item",
      payload: { type: "reasoning", encrypted_content: "x".repeat(80 * 1024) },
    },
    message("assistant", "Recent progress survives the tail read.", "2026-07-17T00:00:02.000Z", "commentary", "long-turn"),
    message("assistant", "Recent result survives too.", "2026-07-17T00:00:03.000Z", "final_answer", "long-turn"),
  ];
  await fs.writeFile(file, `${records.map(JSON.stringify).join("\n")}\n`);

  const conversation = await extractSessionConversationFromJsonl(file, { maxBytes: 64 * 1024 });
  assert.deepEqual(conversation.turns, [{
    id: "long-turn",
    user: "Delegated task: Helmholtz",
    startedAt: "",
    assistant: [
      { text: "Recent progress survives the tail read.", phase: "commentary", completedAt: "2026-07-17T00:00:02.000Z" },
      { text: "Recent result survives too.", phase: "final_answer", completedAt: "2026-07-17T00:00:03.000Z" },
    ],
  }]);
});

test("reads a remote Session preview through turns without resuming the thread", async () => {
  const calls = [];
  const client = {
    async listThreadTurns(params) {
      calls.push({ method: "listThreadTurns", params });
      return {
        data: [
          {
            id: "turn-2",
            startedAt: 1_785_227_200,
            status: "interrupted",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "继续处理" }] },
              { type: "reasoning", summary: ["private"] },
            ],
          },
          {
            id: "turn-1",
            startedAt: 1_785_226_600,
            completedAt: 1_785_226_660,
            status: "completed",
            items: [
              { type: "userMessage", content: [{ type: "text", text: "先检查现状" }] },
              { type: "agentMessage", phase: "commentary", text: "正在检查" },
              { type: "agentMessage", phase: "final_answer", text: "检查完成" },
            ],
          },
        ],
        nextCursor: "earlier-page",
      };
    },
  };

  const conversation = await readAppServerSessionConversation(client, "company-thread", { limit: 10 });

  assert.deepEqual(calls, [
    {
      method: "listThreadTurns",
      params: {
        threadId: "company-thread",
        limit: 10,
        sortDirection: "desc",
        itemsView: "full",
      },
    },
  ]);
  assert.equal(conversation.hasEarlier, true);
  assert.deepEqual(conversation.turns.map((turn) => turn.id), ["turn-1", "turn-2"]);
  assert.equal(conversation.turns[0].startedAt, "2026-07-28T08:16:40.000Z");
  assert.deepEqual(
    conversation.turns[0].assistant.map((item) => [item.phase, item.text]),
    [
      ["commentary", "正在检查"],
      ["final_answer", "检查完成"],
    ],
  );
  assert.equal(conversation.turns[1].user, "继续处理");
});

test("normalizes App Server preview pages without exposing reasoning items", () => {
  const conversation = appServerConversationFromTurnPage({
    data: [
      {
        id: "turn-1",
        startedAt: "2026-07-28T08:00:00.000Z",
        items: [
          { type: "reasoning", summary: ["hidden"] },
          { type: "agentMessage", phase: "final_answer", text: "可见回答" },
        ],
      },
    ],
  });

  assert.equal(conversation.turns.length, 1);
  assert.deepEqual(conversation.turns[0].assistant, [
    { text: "可见回答", phase: "final_answer", completedAt: "" },
  ]);
});

test("preview cache is stored atomically and normalized by session id", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-preview-cache-"));
  const file = path.join(directory, "previews.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  saveSessionPreview(file, {
    sessionId: "session-1",
    prompt: "do it",
    result: "done",
    completedAt: "2026-07-17T00:04:00.000Z",
  });

  assert.deepEqual(readSessionPreviews(file)["session-1"], {
    sessionId: "session-1",
    prompt: "do it",
    result: "done",
    completedAt: "2026-07-17T00:04:00.000Z",
    updatedAt: "2026-07-17T00:04:00.000Z",
  });
});

function message(role, text, timestamp, phase = undefined, turnId = "") {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase ? { phase } : {}),
      ...(turnId ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}
