import assert from 'node:assert/strict';
export const metadata = { name: 'voice-live-transcript', profiles: ['desktop', 'mobile'] };
// Run against candidate-preview.mjs --experience; the microphone is replaced by a
// fake VoiceCapture that emits synthetic partials, so no physical audio is captured.
// The fake must be installed via addInitScript: the adapter reads globalThis.VoiceCapture
// at render time, so a post-load page.evaluate injection would be too late.
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
  const textarea = page.locator('.cwu-composer textarea');
  await textarea.waitFor();
  const mic = page.getByRole('button', { name: '语音输入', exact: true });
  await mic.click();
  // 录音中：按钮标红、输入框锁定、partial 直接预填进输入框
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).waitFor();
  assert.equal(await textarea.inputValue(), '正在识别第一句');
  assert.equal(await textarea.getAttribute('readonly'), '');
  await evidence.checkpoint('录音开始：麦克风标红、partial 预填、输入框锁定');
  await page.waitForFunction(() => document.querySelector('.cwu-composer textarea').value === '正在识别第一句，第二句也来了');
  await evidence.checkpoint('流式 partial 持续替换预填内容');
  // 结束：最终转写留在输入框、恢复可编辑
  await page.getByRole('button', { name: '结束录音并转写', exact: true }).click();
  await page.getByRole('button', { name: '语音输入', exact: true }).waitFor();
  assert.equal(await textarea.inputValue(), '第一句。第二句。');
  assert.equal(await textarea.getAttribute('readonly'), null);
  assert.deepEqual(errors, []);
  await evidence.checkpoint('停止后最终转写留在输入框，恢复可编辑');
}
