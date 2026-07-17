import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractSessionPreviewFromJsonl,
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

function message(role, text, timestamp, phase = undefined) {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase ? { phase } : {}),
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}
