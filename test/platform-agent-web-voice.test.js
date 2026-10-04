import assert from 'node:assert/strict';
import test from 'node:test';
import { agentWebVoiceCapture } from '../public/platform-agent-web-voice.js';

test('voice input returns transcription without submitting and binds recovery to its Session', async () => {
  let callbacks;
  const capture = await agentWebVoiceCapture('session-a', {
    appendTranscript: (left, right) => `${left}${right}`,
    create(value) { callbacks = value; return { async start() {}, async stop() { value.onChunk({ text: '第一句' }); value.onChunk({ text: '第二句' }); value.onComplete({ failed: false }); }, cancel() { value.onCancel(); } }; },
  }).start();
  assert.equal(callbacks.recoveryContext(), 'session-a');
  assert.equal(await capture.stop(), '第一句第二句');
});

test('failed transcription leaves a recoverable error instead of silently treating partial text as complete', async () => {
  const capture = await agentWebVoiceCapture('session-a', {
    appendTranscript: (left, right) => `${left}${right}`,
    create(value) { return { async start() {}, async stop() { value.onChunk({ text: 'partial' }); value.onComplete({ failed: true }); }, cancel() {} }; },
  }).start();
  await assert.rejects(capture.stop(), /录音已保留/);
});
