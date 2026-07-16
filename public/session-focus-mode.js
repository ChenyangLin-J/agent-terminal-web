(() => {
  const sessionScreen = document.querySelector("#session-screen");
  const viewTabs = sessionScreen?.querySelector(".view-tabs");
  const quickActions = sessionScreen?.querySelector(".quick-actions");
  const sourceVoiceButton = document.querySelector("#voice-input");
  const promptInput = document.querySelector("#prompt");
  const sendPromptButton = document.querySelector("#send-prompt");
  if (!sessionScreen || !viewTabs || !quickActions) return;

  const toggle = document.createElement("button");
  toggle.id = "session-focus-toggle";
  toggle.type = "button";
  toggle.setAttribute("aria-label", "进入专注查看");
  toggle.setAttribute("aria-pressed", "false");
  toggle.title = "专注查看";
  toggle.textContent = "专注";
  viewTabs.classList.add("focus-mode-tabs");
  viewTabs.append(toggle);

  const voiceDock = createVoiceDock();
  sessionScreen.append(voiceDock.root);
  let autoSendPending = false;

  toggle.addEventListener("click", () => setFocusMode(!sessionScreen.classList.contains("session-focus-mode")));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sessionScreen.classList.contains("session-focus-mode")) setFocusMode(false);
  });

  sessionScreen.addEventListener(
    "touchmove",
    (event) => {
      if (sessionScreen.classList.contains("session-focus-mode") && event.touches.length > 1) {
        event.stopImmediatePropagation();
      }
    },
    { capture: true, passive: true },
  );

  new MutationObserver(() => {
    if (sessionScreen.classList.contains("hidden")) setFocusMode(false);
  }).observe(sessionScreen, { attributes: true, attributeFilter: ["class"] });

  function setFocusMode(active) {
    if (active && sessionScreen.classList.contains("hidden")) return;
    const terminalPosition = captureTerminalPosition();
    const textScrollTop = document.querySelector("#terminal-text")?.scrollTop || 0;
    sessionScreen.classList.toggle("session-focus-mode", active);
    toggle.setAttribute("aria-pressed", String(active));
    toggle.setAttribute("aria-label", active ? "退出专注查看" : "进入专注查看");
    toggle.title = active ? "退出专注查看" : "专注查看";
    toggle.textContent = active ? "退出" : "专注";
    refitLocally(terminalPosition, textScrollTop);
  }

  function createVoiceDock() {
    const root = document.createElement("div");
    root.id = "focus-voice-dock";
    root.className = "focus-voice-dock";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "focus-voice-cancel";
    cancel.textContent = "取消";

    const action = document.createElement("button");
    action.type = "button";
    action.className = "focus-voice-action";
    root.append(cancel, action);
    renderVoiceState(sourceVoiceButton?.dataset.voiceState || "idle");

    action.addEventListener("click", async () => {
      const controller = sourceVoiceButton?.agentVoiceInputController;
      if (!controller) return;
      const state = controller.getState();
      if (state === "idle") {
        await controller.start();
        return;
      }
      if (state !== "recording") return;

      autoSendPending = true;
      renderVoiceState("transcribing");
      const result = await controller.stop();
      if (result?.textAdded && promptInput?.value.trim() && !sendPromptButton?.disabled) {
        sendPromptButton.click();
      }
      autoSendPending = false;
      renderVoiceState(controller.getState());
    });

    cancel.addEventListener("click", async () => {
      const controller = sourceVoiceButton?.agentVoiceInputController;
      if (!controller || !["starting", "recording"].includes(controller.getState())) return;
      await controller.cancel();
    });

    sourceVoiceButton?.addEventListener("agentvoicestatechange", (event) => {
      if (autoSendPending && event.detail.state === "idle") return;
      renderVoiceState(event.detail.state);
    });

    return { root };

    function renderVoiceState(state) {
      const recording = state === "recording";
      const starting = state === "starting";
      const waiting = starting || state === "cancelling" || state === "transcribing";
      const cancellable = starting || recording;
      root.classList.toggle("recording", recording || waiting);
      sessionScreen.classList.toggle("session-focus-voice-active", recording || waiting);
      cancel.classList.toggle("hidden", !cancellable);
      cancel.disabled = !cancellable;
      action.classList.toggle("recording", recording);
      action.disabled = waiting;
      action.innerHTML = recording ? "<span>发送</span>" : waiting ? waitIcon() : microphoneIcon();
      const label = recording ? "结束录音并发送" : waiting ? "正在完成转写" : "开始语音输入";
      action.setAttribute("aria-label", label);
      action.title = label;
    }
  }

  function captureTerminalPosition() {
    if (typeof terminal === "undefined" || !terminal) return null;
    const buffer = terminal.buffer.active;
    return {
      atBottom: buffer.viewportY >= buffer.baseY - 1,
      viewportY: buffer.viewportY,
    };
  }

  function refitLocally(position, textScrollTop) {
    requestAnimationFrame(() => {
      if (sessionScreen.classList.contains("hidden")) return;
      const textArea = document.querySelector("#terminal-text");
      if (textArea && !textArea.closest(".text-view")?.classList.contains("hidden")) {
        textArea.scrollTop = textScrollTop;
        return;
      }
      if (typeof terminal === "undefined" || !terminal || typeof fitAddon === "undefined" || !fitAddon) return;
      fitAddon.fit();
      requestAnimationFrame(() => {
        if (!position) return;
        if (position.atBottom) terminal.scrollToBottom();
        else terminal.scrollToLine(position.viewportY);
      });
    });
  }

  function microphoneIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/><path d="M9 21h6"/></svg>`;
  }

  function waitIcon() {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/></svg>`;
  }
})();
