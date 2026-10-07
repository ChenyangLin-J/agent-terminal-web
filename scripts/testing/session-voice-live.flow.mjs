import assert from 'node:assert/strict';
export const metadata = { name: 'voice-live-transcript', profiles: ['desktop', 'mobile'] };
// Run against candidate-preview.mjs --experience; the microphone is replaced by a
// fake VoiceCapture that emits synthetic partials, so no physical audio is captured.
export default async function ({ page, evidence, baseUrl, profile }) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    // candidate-preview 的 WORKSPACE_ROOT 不含 shared-web，真实 widget 不会加载，不会覆盖此替身。
    window.VoiceCapture = {
      appendTranscript: (acc, text) => `${acc}${text}`,
      create: (options) => ({
        start: async () => {
          options.onPartial?.({ text: '正在识别第一句' });
          setTimeout(() => options.onPartial?.({ text: '正在识别第一句，第二句也来了' }), 400);
        },
        stop: async () => {
          options.onChunk?.({ text: '第一句。第二句。' });
          options.onComplete?.({ failed: false });
        },
        cancel: () => options.onCancel?.(),
      }),
    };
  });
  await page.goto(baseUrl);
  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.locator('.cwu-composer textarea').waitFor();
  const mic = page.getByRole('button', { name: '语音输入', exact: true });
  await mic.click();
  const live = page.locator('.cwu-voice-live');
  await live.waitFor();
  assert.equal(await live.innerText(), '正在识别第一句');
  await evidence.checkpoint('录音开始即显示实时转写');
  await page.getByText('正在识别第一句，第二句也来了', { exact: true }).waitFor();
  await evidence.checkpoint('流式 partial 持续更新');
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).click();
  await live.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.cwu-composer textarea').inputValue(), '第一句。第二句。');
  assert.deepEqual(errors, []);
  await evidence.checkpoint('停止后转写进入输入框，实时行消失');
}
