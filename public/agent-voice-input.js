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
    let state = "idle";
    let promptBeforeRecording = "";
    let recordingAddedText = false;
    let lastCompletion = null;

    const controller = {
      install,
      toggle,
      start,
      stop,
      cancel,
      getState: () => state,
    };
    button.agentVoiceInputController = controller;
    return controller;

    function install() {
      button.addEventListener("click", toggle);
    }

    async function toggle() {
      if (state === "recording") return stop();
      if (state !== "idle") return null;
      return start();
    }

    async function start() {
      if (state !== "idle") return false;
      if (!voiceCapture) installVoiceCapture();
      promptBeforeRecording = promptInput.value || "";
      recordingAddedText = false;
      lastCompletion = null;
      setVoiceState("starting");
      try {
        await voiceCapture.start();
        if (!["starting", "recording"].includes(state)) {
          await voiceCapture.cancel();
          return false;
        }
        return true;
      } catch (error) {
        setVoiceState("idle");
        setUploadStatus(error.message || "无法开始录音。");
        return false;
      }
    }

    async function stop() {
      if (!voiceCapture || state !== "recording") return null;
      await voiceCapture.stop();
      return {
        summary: lastCompletion,
        textAdded: recordingAddedText,
      };
    }

    async function cancel() {
      if (!voiceCapture || !["starting", "recording"].includes(state)) return false;
      setVoiceState("cancelling");
      await voiceCapture.cancel();
      promptInput.value = promptBeforeRecording;
      const cursor = promptInput.value.length;
      promptInput.setSelectionRange(cursor, cursor);
      VoiceCapture.removeDraft(VOICE_DRAFT_KEY);
      setVoiceState("idle");
      setUploadStatus("已取消录音。", { clear: true });
      return true;
    }

    function installVoiceCapture() {
      voiceCapture = VoiceCapture.create({
        streamEndpoint: TRANSCRIPTION_STREAM_ENDPOINT,
        onStart() {
          if (state !== "starting") {
            void voiceCapture.cancel();
            return;
          }
          VoiceCapture.saveDraft(VOICE_DRAFT_KEY, promptInput.value || "");
          setVoiceState("recording");
          setUploadStatus("录音中...");
        },
        onStopping() {
          setVoiceState("transcribing");
          setUploadStatus("收尾转写中...");
        },
        onChunk(event) {
          if (event.text && ["recording", "transcribing"].includes(state)) {
            recordingAddedText = true;
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
          if (state === "starting") setVoiceState("idle");
          setUploadStatus(event.error?.message || `第 ${event.index} 段转写失败。`);
        },
        onProgress(event) {
          if (event.pending > 0) setUploadStatus(`转写中，剩余 ${event.pending} 段...`);
        },
        onComplete(summary) {
          lastCompletion = summary;
          setVoiceState("idle");
          VoiceCapture.removeDraft(VOICE_DRAFT_KEY);
          if (summary.failed) {
            setUploadStatus(`完成，但有 ${summary.failed} 段失败。`);
          } else if (summary.chunks) {
            setUploadStatus("已转写。", { clear: true });
          } else {
            setUploadStatus("没有录到音频。");
          }
        },
        onCancel() {
          setVoiceState("idle");
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

    function setVoiceState(nextState) {
      const previousState = state;
      state = nextState;
      button.dataset.voiceState = state;
      const recording = state === "recording";
      const starting = state === "starting";
      const cancelling = state === "cancelling";
      const transcribing = state === "transcribing";
      const waiting = starting || cancelling || transcribing;
      button.classList.toggle("recording", recording);
      button.disabled = waiting;
      button.innerHTML = recording ? VOICE_STOP_ICON : waiting ? VOICE_WAIT_ICON : VOICE_MIC_ICON;
      const label = recording
        ? "停止录音"
        : starting
          ? "正在连接话筒"
          : cancelling
            ? "正在取消"
            : transcribing
              ? "转写中"
              : "语音输入";
      button.setAttribute("aria-label", label);
      button.title = label;
      if (previousState !== state) {
        button.dispatchEvent(
          new CustomEvent("agentvoicestatechange", {
            bubbles: true,
            detail: { state },
          }),
        );
      }
    }
  }

  window.AgentVoiceInput = {
    create: createVoiceInputController,
  };
})();
