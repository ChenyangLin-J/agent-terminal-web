(function () {
  const TRANSCRIPTION_STREAM_ENDPOINT = "https://home.chenyanglin.com/api/transcribe/stream";
  const VOICE_DRAFT_KEY = "agent_voice_draft";
  const VOICE_MIC_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
    <path d="M5 11a7 7 0 0 0 14 0" />
    <path d="M12 18v3" />
    <path d="M9 21h6" />
  </svg>`;
  const VOICE_STOP_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M8 8h8v8H8z" />
  </svg>`;
  const VOICE_WAIT_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v3" />
    <path d="M12 18v3" />
    <path d="M3 12h3" />
    <path d="M18 12h3" />
  </svg>`;

  function createVoiceInputController({ button, promptInput, setUploadStatus }) {
    let voiceCapture = null;

    return {
      install,
      toggle,
    };

    function install() {
      button.addEventListener("click", toggle);
    }

    async function toggle() {
      if (!voiceCapture) installVoiceCapture();

      if (voiceCapture.isRecording()) {
        await voiceCapture.stop();
        return;
      }

      try {
        await voiceCapture.start();
      } catch (error) {
        setVoiceState("idle");
        setUploadStatus(error.message || "无法开始录音。");
      }
    }

    function installVoiceCapture() {
      voiceCapture = VoiceCapture.create({
        streamEndpoint: TRANSCRIPTION_STREAM_ENDPOINT,
        onStart() {
          VoiceCapture.saveDraft(VOICE_DRAFT_KEY, promptInput.value || "");
          setVoiceState("recording");
          setUploadStatus("录音中...");
        },
        onStopping() {
          setVoiceState("transcribing");
          setUploadStatus("收尾转写中...");
        },
        onChunk(event) {
          if (event.text) {
            insertVoiceText(event.text);
            VoiceCapture.saveDraft(VOICE_DRAFT_KEY, promptInput.value || "");
            setUploadStatus("已转写，继续录音中...");
          } else {
            setUploadStatus("没有识别到语音。");
          }
        },
        onPartial(event) {
          setUploadStatus(`实时转写中：${event.text.slice(-32)}`);
        },
        onChunkError(event) {
          setUploadStatus(event.error?.message || `第 ${event.index} 段转写失败。`);
        },
        onProgress(event) {
          if (event.pending > 0) setUploadStatus(`转写中，剩余 ${event.pending} 段...`);
        },
        onComplete(summary) {
          setVoiceState("idle");
          if (summary.failed) {
            setUploadStatus(`完成，但有 ${summary.failed} 段失败。`);
          } else if (summary.chunks) {
            setUploadStatus("已转写。", { clear: true });
          } else {
            setUploadStatus("没有录到音频。");
          }
        },
      });
    }

    function insertVoiceText(text) {
      const value = promptInput.value;
      const start = promptInput.selectionStart ?? value.length;
      const end = promptInput.selectionEnd ?? value.length;
      const before = value.slice(0, start);
      const after = value.slice(end);
      const nextBefore = VoiceCapture.appendTranscript(before, text);
      const nextValue = `${nextBefore}${after}`;
      const nextCursor = nextBefore.length;

      promptInput.value = nextValue;
      promptInput.focus();
      promptInput.setSelectionRange(nextCursor, nextCursor);
    }

    function setVoiceState(state) {
      const recording = state === "recording";
      const transcribing = state === "transcribing";
      button.classList.toggle("recording", recording);
      button.disabled = transcribing;
      button.innerHTML = recording ? VOICE_STOP_ICON : transcribing ? VOICE_WAIT_ICON : VOICE_MIC_ICON;
      button.setAttribute("aria-label", recording ? "停止录音" : transcribing ? "转写中" : "语音输入");
      button.title = recording ? "停止录音" : transcribing ? "转写中" : "语音输入";
    }
  }

  window.AgentVoiceInput = {
    create: createVoiceInputController,
  };
})();
