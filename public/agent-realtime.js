(function () {
  const TARGET_SAMPLE_RATE = 24_000;
  const REALTIME_V3_VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];
  const DEFAULT_REALTIME_V3_VOICE = REALTIME_V3_VOICES[0];

  function createRealtimeController({
    launchButton,
    dialog,
    dismissButton,
    startButton,
    stopButton,
    fallbackButton,
    voiceSelect,
    statusElement,
    transcriptElement,
    errorElement,
    send,
    fallbackToDictation,
    activateSession,
  }) {
    let enabled = false;
    let launchable = false;
    let preparingSession = false;
    let state = { status: "idle", voice: DEFAULT_REALTIME_V3_VOICE, transcript: [], error: "" };
    let inputContext = null;
    let inputStream = null;
    let inputSource = null;
    let inputProcessor = null;
    let inputSilencer = null;
    let outputContext = null;
    let nextPlaybackAt = 0;

    return {
      install,
      open,
      handleMessage,
      setEnabled,
      setLaunchable,
      failPreparation,
      resetPreparation,
      isPreparing: () => preparingSession,
      isBusy: () => ["starting", "live", "stopping"].includes(state.status),
    };

    function install() {
      launchButton.addEventListener("click", open);
      dismissButton.addEventListener("click", () => dialog.close());
      dialog.addEventListener("click", (event) => {
        if (event.target === dialog) dialog.close();
      });
      startButton.addEventListener("click", start);
      stopButton.addEventListener("click", stop);
      fallbackButton.addEventListener("click", useFallback);
      renderState();
    }

    function open() {
      if (!dialog.open) dialog.showModal();
      if (!enabled) {
        if (!launchable || preparingSession) return;
        clearError();
        if (state.status === "failed") state.status = "idle";
        preparingSession = true;
        renderState();
        try {
          if (activateSession?.() === false) {
            failPreparation("当前 Session 暂时无法启动实时语音。");
          }
        } catch (error) {
          failPreparation(error.message || "无法创建实时语音 Session。");
        }
        return;
      }
      send({ type: "realtime-voices" });
    }

    function setEnabled(value) {
      const nextEnabled = Boolean(value);
      const becameEnabled = nextEnabled && !enabled;
      enabled = nextEnabled;
      if (becameEnabled && preparingSession) {
        preparingSession = false;
        send({ type: "realtime-voices" });
      }
      if (!enabled && ["starting", "live", "stopping"].includes(state.status)) {
        state.error = "连接已断开，麦克风已经停止；重连后请结束并重新开始实时对话。";
        void stopMicrophone();
      }
      renderState();
    }

    function setLaunchable(value) {
      launchable = Boolean(value);
      renderState();
    }

    function failPreparation(message) {
      if (!preparingSession) return;
      preparingSession = false;
      state.status = "failed";
      state.error = message || "无法创建实时语音 Session。";
      renderState();
    }

    function resetPreparation() {
      if (!preparingSession) return;
      preparingSession = false;
      renderState();
    }

    async function start() {
      if (!enabled || ["starting", "live", "stopping"].includes(state.status)) return;
      clearError();
      state = {
        status: "starting",
        voice: normalizeVoice(voiceSelect.value || state.voice),
        transcript: [],
        error: "",
      };
      renderState();
      try {
        await startMicrophone();
        if (!send({ type: "realtime-start", voice: state.voice })) {
          throw new Error("连接恢复中，请稍后重试。");
        }
      } catch (error) {
        await stopMicrophone();
        state.status = "failed";
        state.error = error.message || "无法开始实时语音。";
        renderState();
      }
    }

    async function stop() {
      if (!["starting", "live", "stopping"].includes(state.status)) return;
      state.status = "stopping";
      renderState();
      await stopMicrophone();
      if (!send({ type: "realtime-stop" })) {
        state.status = "failed";
        state.error = "连接恢复中，实时语音没有正常停止。";
        renderState();
      }
    }

    async function useFallback() {
      if (["starting", "live", "stopping"].includes(state.status)) {
        send({ type: "realtime-stop" });
        await stopMicrophone();
      }
      dialog.close();
      await fallbackToDictation?.();
    }

    function handleMessage(type, payload = {}) {
      if (type === "realtime-voices") {
        renderVoices(payload);
        return;
      }
      if (type === "realtime-audio") {
        void playAudioChunk(payload).catch((error) => showError(error.message || "语音播放失败。"));
        return;
      }
      if (type === "realtime-error") {
        showError(payload.message || "实时语音失败。");
        void stopMicrophone();
        return;
      }
      if (type !== "realtime-state") return;
      state = {
        status: String(payload.status || "idle"),
        voice: normalizeVoice(payload.voice || state.voice),
        transcript: Array.isArray(payload.transcript) ? payload.transcript : [],
        error: String(payload.error || ""),
      };
      if (state.status === "idle" || state.status === "failed") void stopMicrophone();
      renderState();
    }

    function renderVoices(payload) {
      const received = Array.isArray(payload.voices) ? payload.voices.map(String) : [];
      const supported = received.filter((voice) => REALTIME_V3_VOICES.includes(voice));
      const voices = supported.length ? supported : REALTIME_V3_VOICES;
      const selected = [state.voice, payload.defaultVoice, voiceSelect.value, DEFAULT_REALTIME_V3_VOICE]
        .map(normalizeVoice)
        .find((voice) => voices.includes(voice)) || voices[0];
      voiceSelect.replaceChildren(
        ...voices.map((voice) => {
          const option = document.createElement("option");
          option.value = voice;
          option.textContent = voice;
          return option;
        }),
      );
      voiceSelect.value = selected;
      state.voice = selected;
    }

    function normalizeVoice(value) {
      const voice = String(value || "").trim();
      return REALTIME_V3_VOICES.includes(voice) ? voice : DEFAULT_REALTIME_V3_VOICE;
    }

    function renderState() {
      const labels = {
        idle: "尚未开始",
        starting: "正在连接麦克风…",
        live: "实时对话中",
        stopping: "正在停止…",
        failed: "连接失败",
      };
      statusElement.textContent = preparingSession ? "正在创建 Session…" : labels[state.status] || state.status;
      statusElement.dataset.state = preparingSession ? "starting" : state.status;
      const busy = ["starting", "live", "stopping"].includes(state.status);
      launchButton.disabled = !enabled && !launchable;
      startButton.disabled = !enabled || preparingSession || busy;
      stopButton.disabled = !enabled || !busy || state.status === "stopping";
      voiceSelect.disabled = !enabled || preparingSession || busy;
      fallbackButton.disabled = !enabled || preparingSession;
      errorElement.textContent = state.error || "";
      errorElement.classList.toggle("hidden", !state.error);
      renderTranscript();
    }

    function renderTranscript() {
      const items = Array.isArray(state.transcript) ? state.transcript : [];
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "feature-empty";
        empty.textContent = "开始后可直接说话，Codex 会用语音回应。";
        transcriptElement.replaceChildren(empty);
        return;
      }
      const shouldFollow =
        transcriptElement.scrollHeight - transcriptElement.scrollTop - transcriptElement.clientHeight < 80;
      transcriptElement.replaceChildren(
        ...items.map((item) => {
          const message = document.createElement("article");
          message.className = "realtime-message";
          message.dataset.role = item.role === "user" ? "user" : "assistant";
          message.textContent = item.text || (item.final ? "…" : "正在听…");
          return message;
        }),
      );
      if (shouldFollow) transcriptElement.scrollTop = transcriptElement.scrollHeight;
    }

    async function startMicrophone() {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风输入。");
      await stopMicrophone();
      inputStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("当前浏览器不支持实时音频。");
      inputContext = new AudioContext();
      await inputContext.resume();
      inputSource = inputContext.createMediaStreamSource(inputStream);
      inputProcessor = inputContext.createScriptProcessor(4096, 1, 1);
      inputSilencer = inputContext.createGain();
      inputSilencer.gain.value = 0;
      inputProcessor.onaudioprocess = (event) => {
        if (state.status !== "live") return;
        const source = event.inputBuffer.getChannelData(0);
        const sampleRate = Math.min(TARGET_SAMPLE_RATE, inputContext.sampleRate);
        const samples = downsample(source, inputContext.sampleRate, sampleRate);
        if (!samples.length) return;
        send({
          type: "realtime-audio",
          audio: {
            data: pcm16Base64(samples),
            sampleRate,
            numChannels: 1,
            samplesPerChannel: samples.length,
            itemId: null,
          },
        });
      };
      inputSource.connect(inputProcessor);
      inputProcessor.connect(inputSilencer);
      inputSilencer.connect(inputContext.destination);
    }

    async function stopMicrophone() {
      if (inputProcessor) inputProcessor.onaudioprocess = null;
      inputSource?.disconnect();
      inputProcessor?.disconnect();
      inputSilencer?.disconnect();
      for (const track of inputStream?.getTracks?.() || []) track.stop();
      const context = inputContext;
      inputContext = null;
      inputStream = null;
      inputSource = null;
      inputProcessor = null;
      inputSilencer = null;
      if (context && context.state !== "closed") await context.close().catch(() => {});
    }

    async function playAudioChunk(chunk) {
      const bytes = base64Bytes(chunk.data);
      const channels = Math.max(1, Math.min(2, Number(chunk.numChannels) || 1));
      const sampleRate = Math.max(8_000, Math.min(48_000, Number(chunk.sampleRate) || TARGET_SAMPLE_RATE));
      const sampleCount = Math.floor(bytes.byteLength / 2 / channels);
      if (!sampleCount) return;
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (!AudioContext) throw new Error("当前浏览器不支持语音播放。");
      if (!outputContext || outputContext.state === "closed") outputContext = new AudioContext();
      await outputContext.resume();
      const audioBuffer = outputContext.createBuffer(channels, sampleCount, sampleRate);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let channel = 0; channel < channels; channel += 1) {
        const output = audioBuffer.getChannelData(channel);
        for (let index = 0; index < sampleCount; index += 1) {
          output[index] = view.getInt16((index * channels + channel) * 2, true) / 32768;
        }
      }
      const source = outputContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(outputContext.destination);
      const startsAt = Math.max(outputContext.currentTime + 0.025, nextPlaybackAt);
      source.start(startsAt);
      nextPlaybackAt = startsAt + audioBuffer.duration;
    }

    function showError(message) {
      state.status = "failed";
      state.error = message;
      renderState();
    }

    function clearError() {
      state.error = "";
      errorElement.textContent = "";
      errorElement.classList.add("hidden");
    }
  }

  function downsample(samples, sourceRate, targetRate) {
    if (targetRate >= sourceRate) return new Float32Array(samples);
    const ratio = sourceRate / targetRate;
    const length = Math.max(1, Math.floor(samples.length / ratio));
    const output = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(samples.length, Math.floor((index + 1) * ratio));
      let total = 0;
      for (let cursor = start; cursor < end; cursor += 1) total += samples[cursor];
      output[index] = total / Math.max(1, end - start);
    }
    return output;
  }

  function pcm16Base64(samples) {
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    let binary = "";
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  }

  function base64Bytes(value) {
    const binary = atob(String(value || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  window.AgentRealtime = { create: createRealtimeController, downsample, pcm16Base64 };
})();
