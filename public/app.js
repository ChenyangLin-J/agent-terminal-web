const startScreen = document.querySelector("#start-screen");
const sessionScreen = document.querySelector("#session-screen");
const projectSelect = document.querySelector("#project");
const launchModeSelect = document.querySelector("#launch-mode");
const sessionIdInput = document.querySelector("#session-id");
const connectButton = document.querySelector("#connect");
const refreshSessionsButton = document.querySelector("#refresh-sessions");
const logoutButton = document.querySelector("#logout");
const sessionsList = document.querySelector("#sessions-list");
const codexSessionsList = document.querySelector("#codex-sessions-list");
const archivedCodexSessionsList = document.querySelector("#archived-codex-sessions-list");
const backButton = document.querySelector("#back");
const disconnectButton = document.querySelector("#disconnect");
const terminalTabButton = document.querySelector("#terminal-tab");
const textTabButton = document.querySelector("#text-tab");
const pageUpButton = document.querySelector("#page-up");
const pageDownButton = document.querySelector("#page-down");
const keyUpButton = document.querySelector("#key-up");
const keyDownButton = document.querySelector("#key-down");
const keyEnterButton = document.querySelector("#key-enter");
const keyEscButton = document.querySelector("#key-esc");
const sendStatusButton = document.querySelector("#send-status");
const sendPermissionsButton = document.querySelector("#send-permissions");
const killSessionButton = document.querySelector("#kill-session");
const attachFileButton = document.querySelector("#attach-file");
const voiceInputButton = document.querySelector("#voice-input");
const sendPromptButton = document.querySelector("#send-prompt");
const fileInput = document.querySelector("#file-input");
const promptInput = document.querySelector("#prompt");
const composer = document.querySelector("#composer");
const uploadStatus = document.querySelector("#upload-status");
const terminalView = document.querySelector(".terminal-view");
const textView = document.querySelector("#text-view");
const terminalText = document.querySelector("#terminal-text");

const statusEls = {
  connection: document.querySelector("#connection"),
  project: document.querySelector("#session-project"),
};

const PAGE_SCROLL_OVERLAP_RATIO = 0.18;
const PAGE_SCROLL_MIN_OVERLAP = 3;
const PAGE_SCROLL_MAX_OVERLAP = 8;
const PAGE_DOWN_LONG_PRESS_MS = 450;
const DEFAULT_DOCUMENT_TITLE = "Agent Terminal Web";

let terminal = null;
let fitAddon = null;
let terminalTouchY = null;
let fitFrame = null;
let fitTimer = null;
let lastSentCols = 0;
let lastSentRows = 0;
let pageDownLongPressTimer = null;
let pageDownLongPressFired = false;

let socket = null;
let sessionsTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let activeSessionId = "";
let currentSessionExited = false;
let uploadStatusTimer = null;
let liveSessionsByCodexId = new Map();
let mediaRecorder = null;
let voiceStream = null;
let audioChunks = [];

window.addEventListener("resize", () => fitTerminal({ delay: 120 }));

logoutButton.addEventListener("click", logout);
connectButton.addEventListener("click", () => startSession());
refreshSessionsButton.addEventListener("click", refreshLists);
backButton.addEventListener("click", showStartScreen);
disconnectButton.addEventListener("click", detach);
terminalTabButton.addEventListener("click", closeTextView);
textTabButton.addEventListener("click", openTextView);
pageUpButton.addEventListener("click", () => scrollTerminalPage(-1));
pageDownButton.addEventListener("click", (event) => {
  if (pageDownLongPressFired) {
    event.preventDefault();
    pageDownLongPressFired = false;
    return;
  }
  scrollTerminalPage(1);
});
keyUpButton.addEventListener("click", () => sendTerminalKey("\x1b[A"));
keyDownButton.addEventListener("click", () => sendTerminalKey("\x1b[B"));
keyEnterButton.addEventListener("click", () => sendTerminalKey("\r"));
keyEscButton.addEventListener("click", () => sendTerminalKey("\x1b"));
sendStatusButton.addEventListener("click", () => command("/status"));
sendPermissionsButton.addEventListener("click", () => command("/permissions"));
killSessionButton.addEventListener("click", endSession);
attachFileButton.addEventListener("click", () => fileInput.click());
voiceInputButton.addEventListener("click", toggleVoiceInput);
sendPromptButton.addEventListener("click", submitPrompt);
fileInput.addEventListener("change", async () => {
  await uploadFiles(fileInput.files);
  fileInput.value = "";
});
promptInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});
installComposerDragUpload();
installPageDownLongPress();

bootstrap().catch(() => {
  redirectToLogin();
});

async function bootstrap() {
  const response = await fetch("/api/auth");
  const data = await response.json();
  if (data.authenticated) {
    await loadProjects();
    if (openInitialSessionFromUrl()) return;
    showStartScreen();
    await refreshLists();
  } else {
    redirectToLogin(data.loginUrl);
  }
}

async function logout() {
  detach(false);
  const response = await fetch("/api/logout", { method: "POST" });
  const data = await response.json();
  window.location.href = data.logoutUrl || "https://auth.chenyanglin.com/logout";
}

async function loadProjects() {
  const data = await apiJson("/api/projects");
  if (!data) return;

  projectSelect.innerHTML = "";
  const rootOption = document.createElement("option");
  rootOption.value = ".";
  rootOption.textContent = "workspace";
  projectSelect.append(rootOption);

  for (const project of data.projects) {
    const option = document.createElement("option");
    option.value = project;
    option.textContent = project;
    projectSelect.append(option);
  }

  projectSelect.value = ".";
}

async function refreshLists() {
  await loadLiveSessions();
  await Promise.all([loadSavedCodexSessions(), loadArchivedCodexSessions()]);
  scrollStartScreenToBottom();
}

async function loadLiveSessions() {
  const data = await apiJson("/api/sessions");
  if (data) renderLiveSessions(data.sessions || []);
}

async function loadSavedCodexSessions() {
  const data = await apiJson("/api/codex-sessions");
  if (data) renderSavedCodexSessions(data.sessions || []);
}

async function loadArchivedCodexSessions() {
  const data = await apiJson("/api/codex-sessions/archived");
  if (data) renderArchivedCodexSessions(data.sessions || []);
}

function renderLiveSessions(sessions) {
  const uniqueSessions = uniqueLiveSessions(sessions);
  liveSessionsByCodexId = new Map(
    uniqueSessions.filter((session) => session.sessionId).map((session) => [session.sessionId, session]),
  );
  sessionsList.innerHTML = "";
  if (!uniqueSessions.length) {
    sessionsList.append(empty("No live sessions. Detached sessions stay available for about one hour."));
    return;
  }

  for (const session of uniqueSessions) {
    sessionsList.append(
      sessionCard({
        title: session.title || "New Codex session",
        subtitle: `${displayProject(session.project)} · ${formatLaunch(session)} · ${formatTime(
          session.lastActivityAt,
        )}`,
        action: "Reconnect",
        onClick: () => openSessionTab({ attach: session.id, title: session.title || "New Codex session" }),
      }),
    );
  }
}

function uniqueLiveSessions(sessions) {
  const byKey = new Map();

  for (const session of sessions) {
    const key = session.sessionId || session.id;
    const current = byKey.get(key);
    if (!current || compareLiveSession(session, current) > 0) {
      byKey.set(key, session);
    }
  }

  return [...byKey.values()].sort(
    (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
  );
}

function compareLiveSession(a, b) {
  const clients = (a.connectedClients || 0) - (b.connectedClients || 0);
  if (clients !== 0) return clients;
  return new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime();
}

function renderSavedCodexSessions(sessions) {
  codexSessionsList.innerHTML = "";
  if (!sessions.length) {
    codexSessionsList.append(empty("No saved Codex sessions found."));
    return;
  }

  for (const session of sessions) {
    const liveSession = liveSessionsByCodexId.get(session.id);
    codexSessionsList.append(
      sessionCard({
        title: session.title || "Untitled session",
        subtitle: `${displayProject(session.project)} · ${formatTime(session.updatedAt)}`,
        action: liveSession ? "Open" : "Resume",
        onClick: () =>
          openSessionTab({
            attach: liveSession?.id || "",
            cwd: liveSession ? "" : projectForSession(session),
            sessionId: liveSession ? "" : session.id,
            title: session.title || "Untitled session",
          }),
        secondaryAction: "Rename",
        onSecondaryClick: () => renameCodexSession(session),
        tertiaryAction: "Archive",
        onTertiaryClick: () => archiveCodexSession(session, true),
      }),
    );
  }
}

function renderArchivedCodexSessions(sessions) {
  archivedCodexSessionsList.innerHTML = "";
  if (!sessions.length) {
    archivedCodexSessionsList.append(empty("No archived Codex sessions."));
    return;
  }

  for (const session of sessions) {
    archivedCodexSessionsList.append(
      sessionCard({
        title: session.title || "Untitled session",
        subtitle: `${displayProject(session.project)} · archived ${formatTime(
          session.archivedAt || session.updatedAt,
        )}`,
        action: "Restore",
        onClick: () => archiveCodexSession(session, false),
        secondaryAction: "Rename",
        onSecondaryClick: () => renameCodexSession(session),
      }),
    );
  }
}

function sessionCard({
  title,
  subtitle,
  action,
  onClick,
  secondaryAction,
  onSecondaryClick,
  tertiaryAction,
  onTertiaryClick,
}) {
  const card = document.createElement("div");
  card.className = "session-card";
  const meta = document.createElement("div");
  meta.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(subtitle)}</span>`;
  const actions = document.createElement("div");
  actions.className = "session-card-actions";
  if (secondaryAction) {
    const secondaryButton = document.createElement("button");
    secondaryButton.type = "button";
    secondaryButton.className = "secondary";
    secondaryButton.textContent = secondaryAction;
    secondaryButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onSecondaryClick?.();
    });
    actions.append(secondaryButton);
  }
  if (tertiaryAction) {
    const tertiaryButton = document.createElement("button");
    tertiaryButton.type = "button";
    tertiaryButton.className = "secondary";
    tertiaryButton.textContent = tertiaryAction;
    tertiaryButton.addEventListener("click", (event) => {
      event.stopPropagation();
      onTertiaryClick?.();
    });
    actions.append(tertiaryButton);
  }
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = action;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick?.();
  });
  actions.append(button);
  card.append(meta, actions);
  return card;
}

async function renameCodexSession(session) {
  const currentTitle = session.customTitle || session.title || "";
  const title = window.prompt("Session title", currentTitle);
  if (title === null) return;

  const response = await fetch(`/api/codex-sessions/${encodeURIComponent(session.id)}/title`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (response.status === 401) {
    redirectToLogin();
    return;
  }
  if (!response.ok) {
    window.alert("Failed to save title.");
    return;
  }
  await loadSavedCodexSessions();
  await loadArchivedCodexSessions();
}

async function archiveCodexSession(session, archived) {
  const ok = archived ? window.confirm("Archive this session?") : true;
  if (!ok) return;

  const response = await fetch(`/api/codex-sessions/${encodeURIComponent(session.id)}/archive`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived }),
  });
  if (response.status === 401) {
    redirectToLogin();
    return;
  }
  if (!response.ok) {
    window.alert(archived ? "Failed to archive session." : "Failed to restore session.");
    return;
  }
  await Promise.all([loadSavedCodexSessions(), loadArchivedCodexSessions()]);
}

function empty(text) {
  const element = document.createElement("p");
  element.className = "empty";
  element.textContent = text;
  return element;
}

function startSession(overrides = {}) {
  openSocket({
    cwd: overrides.cwd || projectSelect.value,
    mode: overrides.sessionId ? "new" : launchModeSelect.value,
    sessionId: overrides.sessionId || sessionIdInput.value.trim(),
  });
}

function attachSession(id) {
  openSocket({ attach: id });
}

function openInitialSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const attach = params.get("attach") || "";
  const sessionId = params.get("sessionId") || "";
  const title = params.get("title") || "";

  if (title) setDocumentTitle(title);

  if (attach) {
    attachSession(attach);
    return true;
  }

  if (sessionId) {
    startSession({
      cwd: params.get("cwd") || ".",
      sessionId,
    });
    return true;
  }

  return false;
}

function openSessionTab(params) {
  window.open(sessionUrl(params), "_blank", "noopener");
}

function sessionUrl(params) {
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function openSocket(params, options = {}) {
  const isReconnect = Boolean(options.reconnect);
  closeSocket();
  ensureTerminal();
  if (!isReconnect) terminal?.clear();
  activeSessionId = params.attach || "";
  currentSessionExited = false;
  setConnectedState(isReconnect ? "reconnecting" : "connecting");
  showSessionScreen();

  const query = new URLSearchParams(params);
  if (isReconnect) query.set("replay", "0");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/terminal?${query.toString()}`);

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConnectedState("connected");
    lastSentCols = 0;
    lastSentRows = 0;
    fitTerminal();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "output") {
      writeTerminalOutput(message.payload.raw);
      return;
    }
    if (message.type === "replay") {
      if (isReconnect) return;
      writeTerminalOutput(message.payload.raw, { replay: true });
      return;
    }
    if (message.type === "status") {
      renderStatus(message.payload);
      return;
    }
    if (message.type === "error") {
      terminal?.writeln(`\r\n${message.payload.message}\r\n`);
    }
  });

  socket.addEventListener("close", (event) => {
    if (socket === event.currentTarget) socket = null;
    if (event.currentTarget.intentionalClose) return;
    if (!currentSessionExited && activeSessionId && !sessionScreen.classList.contains("hidden")) {
      scheduleReconnect();
      return;
    }
    setConnectedState("detached");
    refreshLists();
  });
}

function submitPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  send({ type: "submit", data: prompt });
  promptInput.value = "";
}

function command(value) {
  send({ type: "command", data: value });
}

function sendTerminalKey(value) {
  send({ type: "input", data: value });
}

function detach(goHome = true) {
  closeSocket();
  if (goHome) showStartScreen();
}

function closeSocket() {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (socket) {
    socket.intentionalClose = true;
    socket.close();
    socket = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (reconnectAttempts >= 8) {
    setConnectedState("detached");
    refreshLists();
    return;
  }
  setConnectedState("reconnecting");
  const delay = Math.min(5000, 750 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    if (!activeSessionId || currentSessionExited || sessionScreen.classList.contains("hidden")) return;
    openSocket({ attach: activeSessionId }, { reconnect: true });
  }, delay);
}

function endSession() {
  send({ type: "kill" });
  detach(true);
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

async function uploadFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;

  const form = new FormData();
  for (const file of files) form.append("files", file);

  setUploading(true);
  setUploadStatus("Uploading...");

  try {
    const response = await fetch("/api/uploads", {
      method: "POST",
      body: form,
    });

    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Upload failed.");

    insertUploadedFiles(data.files || []);
    setUploadStatus(`Attached ${(data.files || []).length} file${(data.files || []).length === 1 ? "" : "s"}.`, {
      clear: true,
    });
  } catch (error) {
    setUploadStatus(error.message || "Upload failed.");
  } finally {
    setUploading(false);
  }
}

async function toggleVoiceInput() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    setVoiceState("transcribing");
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    setUploadStatus("Voice input is not supported in this browser.");
    return;
  }

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(voiceStream);
    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) audioChunks.push(event.data);
    });
    mediaRecorder.addEventListener("stop", transcribeRecordedAudio, { once: true });
    mediaRecorder.start();
    setVoiceState("recording");
    setUploadStatus("Recording...");
  } catch (error) {
    stopVoiceStream();
    setVoiceState("idle");
    setUploadStatus(error.message || "Failed to start recording.");
  }
}

async function transcribeRecordedAudio() {
  stopVoiceStream();

  const mimeType = mediaRecorder?.mimeType || "audio/webm";
  const blob = new Blob(audioChunks, { type: mimeType });
  audioChunks = [];

  if (!blob.size) {
    setVoiceState("idle");
    setUploadStatus("No audio recorded.");
    return;
  }

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });

    if (response.status === 401) {
      redirectToLogin();
      return;
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.error || "Transcribe failed.");

    if (data.text) {
      insertPromptText(data.text);
      setUploadStatus("Transcribed.", { clear: true });
    } else {
      setUploadStatus("No speech recognized.");
    }
  } catch (error) {
    setUploadStatus(error.message || "Transcribe failed.");
  } finally {
    setVoiceState("idle");
    mediaRecorder = null;
  }
}

function stopVoiceStream() {
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceStream = null;
}

function setVoiceState(state) {
  const recording = state === "recording";
  const transcribing = state === "transcribing";
  voiceInputButton.classList.toggle("recording", recording);
  voiceInputButton.disabled = transcribing;
  voiceInputButton.textContent = recording ? "Stop" : transcribing ? "..." : "Mic";
}

function installComposerDragUpload() {
  if (!composer) return;

  composer.addEventListener("dragenter", (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    composer.classList.add("drag-over");
  });

  composer.addEventListener("dragover", (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    composer.classList.add("drag-over");
  });

  composer.addEventListener("dragleave", (event) => {
    if (event.relatedTarget && composer.contains(event.relatedTarget)) return;
    composer.classList.remove("drag-over");
  });

  composer.addEventListener("drop", (event) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    composer.classList.remove("drag-over");
    uploadFiles(event.dataTransfer.files);
  });
}

function hasDraggedFiles(event) {
  return [...(event.dataTransfer?.types || [])].includes("Files");
}

function insertUploadedFiles(files) {
  const paths = files.map((file) => file.path).filter(Boolean);
  if (!paths.length) return;
  insertPromptText(paths.map((filePath) => `请读取这个文件：${filePath}`).join("\n"));
}

function insertPromptText(text) {
  const value = promptInput.value;
  const start = promptInput.selectionStart ?? value.length;
  const end = promptInput.selectionEnd ?? value.length;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !text.endsWith("\n") ? "\n" : "";
  const nextValue = `${before}${prefix}${text}${suffix}${after}`;
  const nextCursor = before.length + prefix.length + text.length;

  promptInput.value = nextValue;
  promptInput.focus();
  promptInput.setSelectionRange(nextCursor, nextCursor);
}

function setUploading(uploading) {
  attachFileButton.disabled = uploading;
  attachFileButton.textContent = uploading ? "Uploading" : "Attach";
}

function setUploadStatus(message, { clear = false } = {}) {
  window.clearTimeout(uploadStatusTimer);
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("active", Boolean(message));
  if (clear) {
    uploadStatusTimer = window.setTimeout(() => {
      uploadStatus.textContent = "";
      uploadStatus.classList.remove("active");
    }, 2500);
  }
}

function sendResize() {
  if (!terminal || !terminal.cols || !terminal.rows) return;
  if (terminal.cols === lastSentCols && terminal.rows === lastSentRows) return;
  lastSentCols = terminal.cols;
  lastSentRows = terminal.rows;
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}

function renderStatus(status) {
  activeSessionId = status.id || activeSessionId;
  currentSessionExited = Boolean(status.exited);
  statusEls.project.textContent = status.title || displayProject(status.project);
  statusEls.connection.textContent = status.exited ? "exited" : "connected";
  setDocumentTitle(status.title || displayProject(status.project));
}

function setConnectedState(state) {
  statusEls.connection.textContent = state;
  const connected = state === "connected";
  sendPromptButton.disabled = !connected;
  textTabButton.disabled = !connected;
  pageUpButton.disabled = !connected;
  pageDownButton.disabled = !connected;
  keyUpButton.disabled = !connected;
  keyDownButton.disabled = !connected;
  keyEnterButton.disabled = !connected;
  keyEscButton.disabled = !connected;
  sendStatusButton.disabled = !connected;
  sendPermissionsButton.disabled = !connected;
  killSessionButton.disabled = !connected;
}

function showStartScreen() {
  setDocumentTitle(DEFAULT_DOCUMENT_TITLE);
  clearSessionUrl();
  startScreen.classList.remove("hidden");
  sessionScreen.classList.add("hidden");
  window.clearInterval(sessionsTimer);
  refreshLists();
  sessionsTimer = window.setInterval(refreshLists, 10_000);
}

function scrollStartScreenToBottom() {
  if (startScreen.classList.contains("hidden")) return;
  requestAnimationFrame(() => {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "auto" });
  });
}

function showSessionScreen() {
  startScreen.classList.add("hidden");
  sessionScreen.classList.remove("hidden");
  closeTextView();
  window.clearInterval(sessionsTimer);
  fitTerminal();
}

function fitTerminal({ delay = 0 } = {}) {
  if (!terminal || !fitAddon) return;

  window.clearTimeout(fitTimer);
  if (delay > 0) {
    fitTimer = window.setTimeout(() => fitTerminal(), delay);
    return;
  }

  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = null;
    if (sessionScreen.classList.contains("hidden") || textView.classList.contains("hidden") === false) return;
    fitAddon.fit();
    sendResize();
  });
}

function scrollTerminalPage(direction) {
  if (!terminal) return;
  terminal.scrollLines(direction * pageScrollLines());
}

function pageScrollLines() {
  const rows = terminal?.rows || 30;
  const overlap = Math.max(
    PAGE_SCROLL_MIN_OVERLAP,
    Math.min(PAGE_SCROLL_MAX_OVERLAP, Math.round(rows * PAGE_SCROLL_OVERLAP_RATIO)),
  );
  return Math.max(1, rows - overlap);
}

function scrollTerminalToBottom() {
  terminal?.scrollToBottom();
}

function installPageDownLongPress() {
  pageDownButton.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    window.clearTimeout(pageDownLongPressTimer);
    pageDownLongPressFired = false;
    pageDownLongPressTimer = window.setTimeout(() => {
      pageDownLongPressFired = true;
      scrollTerminalToBottom();
    }, PAGE_DOWN_LONG_PRESS_MS);
  });

  for (const eventName of ["pointerup", "pointercancel", "pointerleave"]) {
    pageDownButton.addEventListener(eventName, () => {
      window.clearTimeout(pageDownLongPressTimer);
      pageDownLongPressTimer = null;
    });
  }
}

function getTerminalBufferText() {
  if (!terminal) return "";

  const buffer = terminal.buffer.active;
  const lines = [];
  for (let i = 0; i < buffer.length; i += 1) {
    lines.push(buffer.getLine(i)?.translateToString(true) || "");
  }
  return lines.join("\n").trimEnd();
}

function writeTerminalOutput(raw, { replay = false } = {}) {
  if (!terminal) return;

  const shouldFollow = replay || isTerminalAtBottom();
  const previousViewportY = terminal.buffer.active.viewportY;
  terminal?.write(raw, () => {
    if (shouldFollow) {
      terminal.scrollToBottom();
    } else {
      terminal.scrollToLine(previousViewportY);
    }
    if (!textView.classList.contains("hidden")) {
      terminalText.value = getTerminalBufferText();
    }
  });
}

function isTerminalAtBottom() {
  if (!terminal) return true;
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY - 1;
}

function openTextView() {
  if (!terminal) return;

  terminalText.value = getTerminalBufferText();
  terminalView.classList.add("hidden");
  textView.classList.remove("hidden");
  terminalTabButton.classList.remove("active");
  textTabButton.classList.add("active");
}

function closeTextView() {
  if (!terminalView || !textView) return;

  textView.classList.add("hidden");
  terminalView.classList.remove("hidden");
  textTabButton.classList.remove("active");
  terminalTabButton.classList.add("active");
  fitTerminal();
}

function ensureTerminal() {
  if (terminal) return;

  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: 5000,
    theme: {
      background: "#080a0f",
      foreground: "#e8ebf0",
      cursor: "#ffffff",
      selectionBackground: "#334155",
    },
  });
  fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(document.querySelector("#terminal"));
  terminal.onData((data) => {
    send({ type: "input", data });
  });
  installTerminalTouchScroll();
}

function installTerminalTouchScroll() {
  const terminalElement = document.querySelector("#terminal");
  if (!terminalElement) return;

  terminalElement.addEventListener(
    "touchstart",
    (event) => {
      terminalTouchY = event.touches[0]?.clientY ?? null;
    },
    { passive: true },
  );

  terminalElement.addEventListener(
    "touchmove",
    (event) => {
      if (terminalTouchY === null || !terminal) return;
      const nextY = event.touches[0]?.clientY ?? terminalTouchY;
      const delta = terminalTouchY - nextY;
      terminalTouchY = nextY;

      const lineHeight = terminal.options.fontSize * 1.35;
      const lines = Math.trunc(delta / lineHeight);
      if (lines !== 0) {
        terminal.scrollLines(lines);
        event.preventDefault();
      }
    },
    { passive: false },
  );

  terminalElement.addEventListener("touchend", () => {
    terminalTouchY = null;
  });
}

async function apiJson(url) {
  const response = await fetch(url);
  if (response.status === 401) {
    redirectToLogin();
    return null;
  }
  return response.json();
}

function redirectToLogin(loginUrl = "") {
  window.location.href =
    loginUrl || `https://auth.chenyanglin.com/login?next=${encodeURIComponent(window.location.href)}`;
}

function formatLaunch(status) {
  if (status.sessionId) return "resumed";
  if (status.mode === "resume-last") return "resume last";
  return "new session";
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function projectForSession(session) {
  if (session.project && !session.project.startsWith("..") && session.project !== "") {
    return session.project;
  }
  return ".";
}

function displayProject(value) {
  if (!value || value === ".") return "workspace";
  return value;
}

function setDocumentTitle(title) {
  const cleaned = String(title || "").trim();
  document.title = cleaned ? `${cleaned} · Codex Agent` : DEFAULT_DOCUMENT_TITLE;
}

function clearSessionUrl() {
  if (!window.location.search) return;

  const url = new URL(window.location.href);
  for (const key of ["attach", "cwd", "sessionId", "title"]) {
    url.searchParams.delete(key);
  }
  if (url.toString() !== window.location.href) {
    window.history.replaceState(null, "", url.toString());
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
