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

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

const statusEls = {
  connection: document.querySelector("#connection"),
  project: document.querySelector("#session-project"),
};

const PAGE_SCROLL_OVERLAP_RATIO = 0.18;
const PAGE_SCROLL_MIN_OVERLAP = 3;
const PAGE_SCROLL_MAX_OVERLAP = 8;
const PAGE_DOWN_LONG_PRESS_MS = 450;
const DEFAULT_DOCUMENT_TITLE = "Agent Terminal Web";
const ARCHIVED_SESSIONS_PREVIEW_COUNT = 5;
const CLIENT_HEARTBEAT_MS = 15_000;
const CLIENT_STALE_MS = 45_000;
const CLIENT_RESUME_PROBE_MS = 1_500;
const CLIENT_ID_KEY = "agent_terminal_client_id";
const PUSH_DEVICE_ID_KEY = "agent_terminal_push_device_id";
const SESSION_SNAPSHOT_STORE_KEY = "agent_terminal_session_snapshots";
const SESSION_SNAPSHOT_LIMIT = 8;
const SESSION_SNAPSHOT_MAX_CHARS = 200_000;

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
let clientHeartbeatTimer = null;
let visibleProbeTimer = null;
let reconnectAttempts = 0;
let activeSessionId = "";
let activeSessionParams = {};
let currentSessionExited = false;
let lastServerSeenAt = 0;
let uploadStatusTimer = null;
let liveSessionsByCodexId = new Map();
let archivedSessionsExpanded = false;
const clientId = getClientId();
const pushDeviceId = getPushDeviceId();
let pushRegistrationPromise = null;

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
sendPromptButton.addEventListener("click", submitPrompt);
promptInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});
window.AgentUpload.create({
  attachButton: attachFileButton,
  fileInput,
  composer,
  insertPromptText,
  setUploadStatus,
  redirectToLogin,
}).install();
window.AgentVoiceInput.create({
  button: voiceInputButton,
  promptInput,
  setUploadStatus,
}).install();
installPageDownLongPress();
installClientEventLogging();

bootstrap().catch(() => {
  redirectToLogin();
});

async function bootstrap() {
  const response = await fetch("/api/auth");
  const data = await response.json();
  if (data.authenticated) {
    await loadProjects();
    if (globalThis.Notification?.permission === "granted") {
      void ensureAgentPushSubscription().catch(logPushRegistrationError);
    }
    if (openInitialSessionFromUrl()) return;
    showStartScreen();
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
  const savedScrollY = startScreen.classList.contains("hidden") ? null : window.scrollY;
  await loadLiveSessions();
  await Promise.all([loadSavedCodexSessions(), loadArchivedCodexSessions()]);
  if (savedScrollY !== null) window.scrollTo({ top: savedScrollY, behavior: "auto" });
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
        onClick: () =>
          openSessionFromList({
            attach: session.id,
            cwd: session.project || ".",
            sessionId: session.sessionId || "",
            title: session.title || "New Codex session",
          }),
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
  const nonLiveSessions = sessions.filter((session) => !liveSessionsByCodexId.has(session.id));

  if (!nonLiveSessions.length) {
    codexSessionsList.append(empty(sessions.length ? "No other saved sessions." : "No saved Codex sessions found."));
    return;
  }

  for (const session of nonLiveSessions) {
    codexSessionsList.append(
      sessionCard({
        title: session.title || "Untitled session",
        subtitle: `${displayProject(session.project)} · ${formatTime(session.updatedAt)}`,
        action: "Resume",
        onClick: () =>
          openSessionFromList({
            cwd: projectForSession(session),
            sessionId: session.id,
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

  const visibleSessions = archivedSessionsExpanded
    ? sessions
    : sessions.slice(0, ARCHIVED_SESSIONS_PREVIEW_COUNT);

  for (const session of visibleSessions) {
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

  if (sessions.length > ARCHIVED_SESSIONS_PREVIEW_COUNT) {
    const toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "archive-toggle";
    toggleButton.textContent = archivedSessionsExpanded
      ? "Show less"
      : `Show ${sessions.length - ARCHIVED_SESSIONS_PREVIEW_COUNT} more`;
    toggleButton.addEventListener("click", () => {
      archivedSessionsExpanded = !archivedSessionsExpanded;
      renderArchivedCodexSessions(sessions);
    });
    archivedCodexSessionsList.append(toggleButton);
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

function attachSession(id, extra = {}) {
  openSocket({ attach: id, ...extra });
}

function openInitialSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const attach = params.get("attach") || "";
  const sessionId = params.get("sessionId") || "";
  const title = params.get("title") || "";

  if (title) setDocumentTitle(title);

  if (attach) {
    attachSession(attach, {
      cwd: params.get("cwd") || ".",
      sessionId,
    });
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

function openSessionFromList(params) {
  if (shouldOpenSessionInCurrentPage()) {
    window.history.pushState(null, "", sessionUrl(params));
    openSocket(params);
    return;
  }

  openSessionTab(params);
}

function openSessionTab(params) {
  window.open(sessionUrl(params), "_blank", "noopener");
}

function shouldOpenSessionInCurrentPage() {
  return window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;
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
  const snapshotKey = sessionSnapshotKey(params);
  saveActiveSessionSnapshot();
  closeSocket();
  ensureTerminal();
  const hasSnapshot = !isReconnect && hasSessionSnapshot(snapshotKey);
  const shouldReplay = options.replay ?? (!isReconnect && !hasSnapshot);
  if (!isReconnect) {
    terminal?.clear();
    if (hasSnapshot) restoreSessionSnapshot(snapshotKey);
  }
  activeSessionId = params.attach || "";
  activeSessionParams = { ...activeSessionParams, ...params };
  currentSessionExited = false;
  setConnectedState(isReconnect ? "reconnecting" : "connecting");
  showSessionScreen();

  const query = new URLSearchParams(params);
  query.set("clientId", clientId);
  if (!shouldReplay) query.set("replay", "0");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/terminal?${query.toString()}`);

  socket.addEventListener("open", () => {
    markServerSeen();
    logClientEvent("ws-open");
    reconnectAttempts = 0;
    setConnectedState("connected");
    lastSentCols = 0;
    lastSentRows = 0;
    fitTerminal();
    startClientHeartbeat();
  });

  socket.addEventListener("message", (event) => {
    markServerSeen();
    const message = JSON.parse(event.data);
    if (message.type === "client-pong" || message.type === "control-ack") {
      return;
    }
    if (message.type === "output") {
      writeTerminalOutput(message.payload.raw);
      return;
    }
    if (message.type === "replay") {
      if (isReconnect) return;
      writeTerminalReplay(message.payload.raw);
      return;
    }
    if (message.type === "status") {
      renderStatus(message.payload);
      return;
    }
    if (message.type === "error") {
      terminal?.writeln(`\r\n${message.payload.message}\r\n`);
      if (message.payload.goHome) {
        currentSessionExited = true;
        setConnectedState("detached");
        window.setTimeout(showStartScreen, 500);
      }
    }
  });

  socket.addEventListener("close", (event) => {
    stopClientHeartbeat();
    if (socket === event.currentTarget) socket = null;
    if (event.currentTarget.intentionalClose) return;
    logClientEvent("ws-close", { closeCode: event.code, wasClean: event.wasClean });
    if (document.visibilityState !== "visible") {
      setConnectedState("detached");
      return;
    }
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
  void ensureAgentPushSubscription({ requestPermission: true }).catch(logPushRegistrationError);
  if (send({ type: "submit", data: prompt, notificationDeviceId: pushDeviceId })) {
    promptInput.value = "";
  } else {
    setUploadStatus("连接恢复中，文本已保留。");
  }
}

function command(value) {
  send({ type: "command", data: value, notificationDeviceId: pushDeviceId });
}

function sendTerminalKey(value) {
  send({ type: "input", data: value, notificationDeviceId: pushDeviceId });
}

function detach(goHome = true) {
  saveActiveSessionSnapshot();
  closeSocket();
  if (goHome) {
    activeSessionId = "";
    activeSessionParams = {};
    showStartScreen();
  }
}

function closeSocket() {
  window.clearTimeout(reconnectTimer);
  window.clearTimeout(visibleProbeTimer);
  reconnectTimer = null;
  visibleProbeTimer = null;
  stopClientHeartbeat();
  if (socket) {
    socket.intentionalClose = true;
    socket.close();
    socket = null;
  }
}

function sessionSnapshotKey(params = activeSessionParams) {
  const sessionId = String(params.sessionId || "").trim();
  if (sessionId) return `codex:${sessionId}`;

  const attach = String(params.attach || activeSessionId || "").trim();
  if (attach) return `web:${attach}`;

  return "";
}

function saveActiveSessionSnapshot() {
  if (!terminal) return;

  const key = sessionSnapshotKey();
  if (!key) return;

  const text = getTerminalBufferText();
  if (!text) return;

  const snapshots = readSessionSnapshots();
  snapshots[key] = {
    text: text.slice(-SESSION_SNAPSHOT_MAX_CHARS),
    savedAt: Date.now(),
  };
  trimSessionSnapshots(snapshots);
  writeSessionSnapshots(snapshots);
}

function restoreSessionSnapshot(key) {
  if (!terminal || !key) return false;

  const snapshot = readSessionSnapshots()[key];
  if (!snapshot?.text) return false;

  terminal.write(snapshot.text.replace(/\n/g, "\r\n"), () => {
    terminal.scrollToBottom();
    if (!textView.classList.contains("hidden")) {
      terminalText.value = getTerminalBufferText();
    }
  });
  return true;
}

function hasSessionSnapshot(key) {
  if (!key) return false;
  return Boolean(readSessionSnapshots()[key]?.text);
}

function readSessionSnapshots() {
  try {
    const value = sessionStorage.getItem(SESSION_SNAPSHOT_STORE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionSnapshots(snapshots) {
  try {
    sessionStorage.setItem(SESSION_SNAPSHOT_STORE_KEY, JSON.stringify(snapshots));
  } catch {
    try {
      sessionStorage.removeItem(SESSION_SNAPSHOT_STORE_KEY);
    } catch {
      // Ignore storage failures; snapshots are only a display optimization.
    }
  }
}

function trimSessionSnapshots(snapshots) {
  const entries = Object.entries(snapshots).sort((a, b) => (b[1]?.savedAt || 0) - (a[1]?.savedAt || 0));
  for (const [key] of entries.slice(SESSION_SNAPSHOT_LIMIT)) {
    delete snapshots[key];
  }
}

function installClientEventLogging() {
  logClientEvent("page-load");

  document.addEventListener("visibilitychange", () => {
    logClientEvent(`visibility-${document.visibilityState}`);
    if (document.visibilityState === "visible") ensureVisibleConnection("visibility-visible", { probe: true });
  });
  window.addEventListener("pageshow", (event) => {
    logClientEvent("pageshow", { persisted: event.persisted });
    ensureVisibleConnection("pageshow", { probe: true });
  });
  window.addEventListener("pagehide", (event) => {
    saveActiveSessionSnapshot();
    logClientEvent("pagehide", { persisted: event.persisted }, { beacon: true });
  });
  window.addEventListener("online", () => {
    logClientEvent("online", { online: true });
    ensureVisibleConnection("online");
  });
  window.addEventListener("offline", () => {
    logClientEvent("offline", { online: false });
  });
  window.addEventListener("beforeunload", () => {
    saveActiveSessionSnapshot();
    logClientEvent("beforeunload", {}, { beacon: true });
  });
}

function logClientEvent(event, fields = {}, { beacon = false } = {}) {
  const payload = {
    event,
    webSessionId: activeSessionId || "",
    visibilityState: document.visibilityState || "",
    socketState: socketReadyStateName(socket?.readyState),
    online: navigator.onLine,
    path: `${window.location.pathname}${window.location.search}`,
    ...fields,
  };
  const body = JSON.stringify(payload);

  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/client-events", new Blob([body], { type: "application/json" }));
    return;
  }

  fetch("/api/client-events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {});
}

function socketReadyStateName(value) {
  if (value === WebSocket.CONNECTING) return "connecting";
  if (value === WebSocket.OPEN) return "open";
  if (value === WebSocket.CLOSING) return "closing";
  if (value === WebSocket.CLOSED) return "closed";
  return "none";
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
    openSocket(currentReconnectParams(), { reconnect: true });
  }, delay);
}

function startClientHeartbeat() {
  stopClientHeartbeat();
  clientHeartbeatTimer = window.setInterval(() => {
    if (reconnectIfStale("heartbeat-stale")) return;
    if (!send({ type: "client-ping", sentAt: Date.now() }, { allowStale: true })) {
      reconnectIfStale("heartbeat-send-failed");
    }
  }, CLIENT_HEARTBEAT_MS);
}

function stopClientHeartbeat() {
  window.clearInterval(clientHeartbeatTimer);
  clientHeartbeatTimer = null;
}

function markServerSeen() {
  lastServerSeenAt = Date.now();
}

function connectionLooksStale() {
  return socket?.readyState === WebSocket.OPEN && lastServerSeenAt > 0 && Date.now() - lastServerSeenAt > CLIENT_STALE_MS;
}

function reconnectIfStale(reason, { replay = false } = {}) {
  if (!activeSessionId || currentSessionExited || sessionScreen.classList.contains("hidden")) return false;
  if (!connectionLooksStale()) return false;

  logClientEvent("force-reconnect", { reason, staleMs: Date.now() - lastServerSeenAt });
  openSocket(currentReconnectParams(), { reconnect: true, replay });
  return true;
}

function ensureVisibleConnection(reason, { probe = false, replay = false } = {}) {
  if (!activeSessionId || currentSessionExited || sessionScreen.classList.contains("hidden")) return false;
  if (document.visibilityState !== "visible") return false;
  if (socket?.readyState === WebSocket.OPEN) {
    if (reconnectIfStale(reason, { replay })) return true;
    if (probe) return probeVisibleConnection(reason);
    return false;
  }
  if (socket?.readyState === WebSocket.CONNECTING) return false;

  logClientEvent("visible-reconnect", { reason });
  openSocket(currentReconnectParams(), { reconnect: true });
  return true;
}

function probeVisibleConnection(reason) {
  if (!socket || socket.readyState !== WebSocket.OPEN || visibleProbeTimer) return false;

  const probeStartedAt = Date.now();
  const seenBeforeProbe = lastServerSeenAt;
  logClientEvent("visible-probe", { reason });

  try {
    socket.send(JSON.stringify({ type: "client-ping", sentAt: probeStartedAt, reason }));
  } catch {
    openSocket(currentReconnectParams(), { reconnect: true });
    return true;
  }

  visibleProbeTimer = window.setTimeout(() => {
    visibleProbeTimer = null;
    if (!activeSessionId || currentSessionExited || sessionScreen.classList.contains("hidden")) return;
    if (document.visibilityState !== "visible") return;
    if (lastServerSeenAt > seenBeforeProbe) return;

    logClientEvent("visible-probe-timeout", { reason, waitedMs: Date.now() - probeStartedAt });
    openSocket(currentReconnectParams(), { reconnect: true });
  }, CLIENT_RESUME_PROBE_MS);

  return false;
}

function currentReconnectParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    attach: activeSessionId,
    cwd: activeSessionParams.cwd || params.get("cwd") || ".",
    sessionId: activeSessionParams.sessionId || params.get("sessionId") || "",
    title: activeSessionParams.title || params.get("title") || "",
  };
}

function endSession() {
  send({ type: "kill" });
  detach(true);
}

function send(message, { allowStale = false } = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  if (!allowStale && reconnectIfStale(`before-${message.type || "send"}`)) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function getClientId() {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;

  const next = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  sessionStorage.setItem(CLIENT_ID_KEY, next);
  return next;
}

function getPushDeviceId() {
  const existing = localStorage.getItem(PUSH_DEVICE_ID_KEY);
  if (existing) return existing;

  const next = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  localStorage.setItem(PUSH_DEVICE_ID_KEY, next);
  return next;
}

function ensureAgentPushSubscription({ requestPermission = false } = {}) {
  if (pushRegistrationPromise) return pushRegistrationPromise;
  pushRegistrationPromise = registerAgentPushSubscription({ requestPermission }).finally(() => {
    pushRegistrationPromise = null;
  });
  return pushRegistrationPromise;
}

async function registerAgentPushSubscription({ requestPermission }) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return false;
  if (Notification.permission === "denied") return false;
  if (Notification.permission === "default") {
    if (!requestPermission) return false;
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      setUploadStatus("浏览器通知未开启。", { clear: true });
      return false;
    }
  }

  const [registration, configResponse] = await Promise.all([
    navigator.serviceWorker.register("/sw.js?v=20260713-fresh-notification-1"),
    fetch("/api/push/config"),
  ]);
  const config = await configResponse.json();
  if (!configResponse.ok || !config.configured || !config.publicKey) return false;

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(config.publicKey),
    });
  }

  const response = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId: pushDeviceId, subscription: subscription.toJSON() }),
  });
  if (!response.ok) throw new Error("Browser notification registration failed");
  return true;
}

function urlBase64ToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function logPushRegistrationError(error) {
  console.warn("Agent notification registration failed", error);
  setUploadStatus("浏览器通知连接失败，本次任务仍会正常运行。", { clear: true });
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
  activeSessionParams = {
    attach: activeSessionId,
    cwd: status.project || ".",
    sessionId: status.sessionId || activeSessionParams.sessionId || "",
    title: status.title || displayProject(status.project),
  };
  currentSessionExited = Boolean(status.exited);
  statusEls.project.textContent = status.title || displayProject(status.project);
  statusEls.connection.textContent = status.exited ? "exited" : "connected";
  setDocumentTitle(status.title || displayProject(status.project));
  syncSessionUrl(status);
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
  saveActiveSessionSnapshot();
  setDocumentTitle(DEFAULT_DOCUMENT_TITLE);
  clearSessionUrl();
  startScreen.classList.remove("hidden");
  sessionScreen.classList.add("hidden");
  window.clearInterval(sessionsTimer);
  refreshLists().then(scrollStartScreenToTop);
  sessionsTimer = window.setInterval(refreshLists, 10_000);
}

function scrollStartScreenToTop() {
  if (startScreen.classList.contains("hidden")) return;
  requestAnimationFrame(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  });
}

function showSessionScreen() {
  startScreen.classList.add("hidden");
  sessionScreen.classList.remove("hidden");
  closeTextView();
  window.clearInterval(sessionsTimer);
  fitTerminal();
}

function syncSessionUrl(status) {
  if (!status.id || sessionScreen.classList.contains("hidden")) return;

  const url = new URL(window.location.href);
  const cwd = status.project || ".";
  const title = status.title || displayProject(status.project);
  const alreadySynced =
    url.searchParams.get("attach") === status.id &&
    (status.sessionId ? url.searchParams.get("sessionId") === status.sessionId : !url.searchParams.has("sessionId")) &&
    url.searchParams.get("cwd") === cwd &&
    url.searchParams.get("title") === title;
  if (alreadySynced) return;

  url.search = "";
  url.searchParams.set("attach", status.id);
  url.searchParams.set("cwd", cwd);
  if (status.sessionId) url.searchParams.set("sessionId", status.sessionId);
  if (title) url.searchParams.set("title", title);
  window.history.replaceState(null, "", url.toString());
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

function writeTerminalReplay(raw) {
  if (!terminal) return;

  terminalView.classList.add("replaying");
  terminal.clear();
  terminal.write(raw, () => {
    terminal.scrollToBottom();
    terminalView.classList.remove("replaying");
    if (!textView.classList.contains("hidden")) {
      terminalText.value = getTerminalBufferText();
    }
    saveActiveSessionSnapshot();
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
