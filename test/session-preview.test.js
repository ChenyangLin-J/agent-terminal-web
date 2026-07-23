import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSessionConversationFromJsonl,
  extractSessionPreviewFromJsonl,
  extractSessionTokenUsageFromJsonl,
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
  assert.equal(conversation.turns[0].user, "request 3");
  assert.equal(conversation.turns[0].id, "019f0000-0000-7000-8000-000000000003");
  assert.deepEqual(
    conversation.turns.at(-1).assistant.map((item) => item.phase),
    ["commentary", "final_answer"],
  );
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
