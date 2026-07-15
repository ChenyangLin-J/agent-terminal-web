import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent voice input transcribes without using the Home capture endpoint", async () => {
  const source = await readFile(new URL("../public/agent-voice-input.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(source, /https:\/\/home\.chenyanglin\.com\/api\/transcribe\/stream/);
  assert.doesNotMatch(source, /\/api\/capture\/transcribe\/stream/);
  assert.match(page, /agent-voice-input\.js\?v=20260716-transcribe-only-1/);
});
