import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent voice input transcribes without using the Home capture endpoint", async () => {
  const source = await readFile(new URL("../public/agent-voice-input.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(source, /https:\/\/home\.chenyanglin\.com\/api\/transcribe\/stream/);
  assert.doesNotMatch(source, /\/api\/capture\/transcribe\/stream/);
  assert.match(source, /button\.agentVoiceInputController = controller/);
  assert.match(source, /async function cancel\(\)/);
  assert.match(source, /async function retry\(\)/);
  assert.match(source, /恢复上次录音/);
  assert.match(source, /正在用原始录音恢复转写/);
  assert.doesNotMatch(source, /完成，但有/);
  assert.match(source, /new CustomEvent\("agentvoicestatechange"/);
  assert.match(page, /voice-recovery-store\.js\?v=20260717-1/);
  assert.match(page, /voice-capture-widget\.js\?v=20260717-recovery-2/);
  assert.match(page, /agent-voice-input\.js\?v=20260717-recovery-1/);
});
