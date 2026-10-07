/** Agent Web owns its transcription endpoint and durable recording recovery. */
export function agentWebVoiceCapture(sessionId, factory = globalThis.VoiceCapture) {
  return {
    async start(hooks = {}) {
      if (!factory?.create) throw new Error('语音输入暂时不可用。');
      let transcript = '';
      let complete, fail;
      const done = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
      done.catch(() => {});
      const capture = factory.create({
        streamEndpoint: 'https://home.chenyanglin.com/api/transcribe/stream',
        recoveryContext: () => sessionId || '',
        onChunk: ({ text }) => { if (text) transcript = factory.appendTranscript(transcript, text); },
        onPartial: (event) => hooks.onPartial?.(event?.text || ''),
        onComplete: (summary) => summary?.failed ? fail(new Error('转写未完成，录音已保留，可恢复后重试。')) : complete(transcript),
        onCancel: () => complete(''),
      });
      await capture.start();
      return { stop: async () => { await capture.stop(); return done; }, dispose: () => capture.cancel?.() };
    },
  };
}
