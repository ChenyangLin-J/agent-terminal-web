const startScreen = document.querySelector("#start-screen");
const sessionScreen = document.querySelector("#session-screen");
const projectSelect = document.querySelector("#project");
const launchModeSelect = document.querySelector("#launch-mode");
const transportSelect = document.querySelector("#transport");
const accessModeSelect = document.querySelector("#access-mode");
const sessionIdInput = document.querySelector("#session-id");
const connectButton = document.querySelector("#connect");
const startThinkButton = document.querySelector("#start-think");
const refreshSessionsButton = document.querySelector("#refresh-sessions");
const logoutButton = document.querySelector("#logout");
const sessionsList = document.querySelector("#sessions-list");
const codexSessionsList = document.querySelector("#codex-sessions-list");
const archivedCodexSessionsList = document.querySelector("#archived-codex-sessions-list");
const resumeEngineDialog = document.querySelector("#resume-engine-dialog");
const resumeSessionTitle = document.querySelector("#resume-session-title");
const resumeAccessMode = document.querySelector("#resume-access-mode");
const resumeAccessWarning = document.querySelector("#resume-access-warning");
const resumeWithTerminal = document.querySelector("#resume-with-terminal");
const resumeWithAppServer = document.querySelector("#resume-with-app-server");
const resumeEngineCancel = document.querySelector("#resume-engine-cancel");
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
const queuePromptButton = document.querySelector("#queue-prompt");
const fileInput = document.querySelector("#file-input");
const promptInput = document.querySelector("#prompt");
const composer = document.querySelector("#composer");
const uploadStatus = document.querySelector("#upload-status");
const turnLedger = document.querySelector("#turn-ledger");
const turnLedgerStatus = document.querySelector("#turn-ledger-status");
const turnRequirements = document.querySelector("#turn-requirements");
const agentRequest = document.querySelector("#agent-request");
const agentRequestTitle = document.querySelector("#agent-request-title");
const agentRequestDetail = document.querySelector("#agent-request-detail");
const agentRequestAnswer = document.querySelector("#agent-request-answer");
const agentRequestAccept = document.querySelector("#agent-request-accept");
const agentRequestSession = document.querySelector("#agent-request-session");
const agentRequestDecline = document.querySelector("#agent-request-decline");
const terminalView = document.querySelector(".terminal-view");
const appServerView = document.querySelector("#app-server-view");
const appServerTranscript = document.querySelector("#app-server-transcript");
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
const AGENT_TIME_ZONE = "Asia/Shanghai";
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
let historySyncPending = false;
let historySyncStartedAt = 0;
let lastOutputRevision = 0;
let queuedOutputRevision = 0;
let uploadStatusTimer = null;
let liveSessionsByCodexId = new Map();
let archivedSessionsExpanded = false;
let latestTurnState = { active: false, turnId: "", requirements: [], queuedTurns: [] };
let activeTransport = "terminal";
let activeAccessMode = "safe";
let activeSessionReady = true;
let pendingAgentRequest = null;
let lastSubmittedPrompt = "";
let pendingResumeSession = null;
let appTranscriptItems = [];
let restoredAppTurnCount = 0;
const openAppProcessGroups = new Set();
const clientId = getClientId();
const notificationTarget = getNotificationTarget();
const pushDeviceId = notificationTarget.deviceId;
const agentDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: AGENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
let pushRegistrationPromise = null;

window.addEventListener("resize", () => fitTerminal({ delay: 120 }));

logoutButton.addEventListener("click", logout);
connectButton.addEventListener("click", () => startSession());
startThinkButton.addEventListener("click", () => startSession({ cwd: ".", mode: "new", purpose: "think" }));
refreshSessionsButton.addEventListener("click", refreshLists);
resumeAccessMode.addEventListener("change", renderResumeAccessWarning);
resumeWithTerminal.addEventListener("click", () => resumePendingSession("terminal"));
resumeWithAppServer.addEventListener("click", () => resumePendingSession("app-server"));
resumeEngineCancel.addEventListener("click", closeResumeEngineDialog);
resumeEngineDialog.addEventListener("click", (event) => {
  if (event.target === resumeEngineDialog) closeResumeEngineDialog();
});
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
sendPromptButton.addEventListener("click", () => submitPrompt("auto"));
queuePromptButton.addEventListener("click", () => submitPrompt("queue"));
agentRequestAccept.addEventListener("click", () => respondToAgentRequest("accept"));
agentRequestSession.addEventListener("click", () => respondToAgentRequest("acceptForSession"));
agentRequestDecline.addEventListener("click", () => respondToAgentRequest("decline"));
promptInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt("auto");
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
            transport: session.transport || "terminal",
            access: session.access || "safe",
            purpose: session.purpose || "",
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
        onClick: () => openResumeEngineDialog(session),
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

function openResumeEngineDialog(session) {
  pendingResumeSession = session;
  resumeSessionTitle.textContent = session.title || "Untitled session";
  resumeAccessMode.value = "safe";
  renderResumeAccessWarning();
  resumeEngineDialog.showModal();
}

function closeResumeEngineDialog() {
  pendingResumeSession = null;
  if (resumeEngineDialog.open) resumeEngineDialog.close();
}

function renderResumeAccessWarning() {
  resumeAccessWarning.classList.toggle("hidden", resumeAccessMode.value !== "full");
}

function resumePendingSession(transport) {
  const session = pendingResumeSession;
  if (!session) return;
  const access = resumeAccessMode.value === "full" ? "full" : "safe";
  pendingResumeSession = null;
  resumeEngineDialog.close();
  openSessionFromList({
    cwd: projectForSession(session),
    sessionId: session.id,
    title: session.title || "Untitled session",
    transport,
    access,
  });
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
    mode: overrides.mode || (overrides.sessionId ? "new" : launchModeSelect.value),
    sessionId: overrides.sessionId || sessionIdInput.value.trim(),
    transport: overrides.transport || transportSelect.value || "terminal",
    access: overrides.access || accessModeSelect.value || "safe",
    purpose: overrides.purpose === "think" ? "think" : "",
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
  const startNew = params.get("new") === "1";
  const transport = params.get("transport") === "app-server" ? "app-server" : "terminal";
  const access = params.get("access") === "full" ? "full" : "safe";
  const purpose = params.get("purpose") === "think" ? "think" : "";

  if (title) setDocumentTitle(title);

  if (attach) {
    attachSession(attach, {
      cwd: params.get("cwd") || ".",
      sessionId,
      transport,
      access,
      purpose,
    });
    return true;
  }

  if (sessionId) {
    startSession({
      cwd: params.get("cwd") || ".",
      sessionId,
      transport,
      access,
      purpose,
    });
    return true;
  }

  if (startNew) {
    startSession({
      cwd: params.get("cwd") || ".",
      mode: "new",
      transport,
      access,
      purpose,
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
  appendNotificationTarget(url);
  return url.toString();
}

function openSocket(params, options = {}) {
  const isReconnect = Boolean(options.reconnect);
  const snapshotKey = sessionSnapshotKey(params);
  saveActiveSessionSnapshot();
  closeSocket();
  ensureTerminal();
  const hasSnapshot = !isReconnect && hasSessionSnapshot(snapshotKey);
  const shouldReplay = options.replay !== false;
  if (!isReconnect) {
    terminal?.reset();
    appTranscriptItems = [];
    restoredAppTurnCount = 0;
    openAppProcessGroups.clear();
    renderAppTranscript();
    lastOutputRevision = 0;
    queuedOutputRevision = 0;
    if (hasSnapshot) restoreSessionSnapshot(snapshotKey);
  }
  historySyncPending = shouldReplay;
  historySyncStartedAt = shouldReplay ? Date.now() : 0;
  activeTransport = params.transport === "app-server" ? "app-server" : "terminal";
  activeAccessMode = params.access === "full" ? "full" : "safe";
  activeSessionReady = activeTransport !== "app-server";
  document.body.classList.toggle("app-server-session", activeTransport === "app-server");
  clearAgentRequest();
  activeSessionId = params.attach || "";
  activeSessionParams = { ...activeSessionParams, ...params };
  currentSessionExited = false;
  setConnectedState(isReconnect ? "reconnecting" : "connecting");
  showSessionScreen();

  const query = new URLSearchParams(params);
  query.set("clientId", clientId);
  if (!shouldReplay) query.set("replay", "0");
  if (shouldReplay && lastOutputRevision > 0) query.set("afterRevision", String(lastOutputRevision));
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(`${protocol}//${window.location.host}/terminal?${query.toString()}`);
  socket = nextSocket;

  nextSocket.addEventListener("open", () => {
    if (socket !== nextSocket) return;
    markServerSeen();
    logClientEvent("ws-open");
    reconnectAttempts = 0;
    setConnectedState(
      activeTransport === "app-server" && !activeSessionReady
        ? "starting"
        : historySyncPending
          ? "loading"
          : "connected",
    );
    lastSentCols = 0;
    lastSentRows = 0;
    fitTerminal();
    refreshTerminalDisplay();
    startClientHeartbeat();
  });

  nextSocket.addEventListener("message", (event) => {
    if (socket !== nextSocket) return;
    markServerSeen();
    const message = JSON.parse(event.data);
    if (message.type === "client-pong") {
      return;
    }
    if (message.type === "control-ack") {
      handleControlAck(message.payload);
      return;
    }
    if (message.type === "output") {
      handleTerminalOutput(message.payload);
      return;
    }
    if (message.type === "replay") {
      if (!shouldReplay) return;
      writeTerminalReplay(message.payload);
      return;
    }
    if (message.type === "status") {
      renderStatus(message.payload);
      return;
    }
    if (message.type === "app-transcript") {
      replaceAppTranscript(message.payload);
      return;
    }
    if (message.type === "app-transcript-upsert") {
      upsertAppTranscript(message.payload);
      return;
    }
    if (message.type === "app-transcript-delta") {
      appendAppTranscriptDelta(message.payload);
      return;
    }
    if (message.type === "agent-request") {
      renderAgentRequest(message.payload);
      return;
    }
    if (message.type === "agent-request-resolved") {
      if (!message.payload.requestId || message.payload.requestId === pendingAgentRequest?.requestId) clearAgentRequest();
      return;
    }
    if (message.type === "error") {
      terminal?.writeln(`\r\n${message.payload.message}\r\n`);
      if (message.payload.preservePrompt && lastSubmittedPrompt && !promptInput.value.trim()) {
        promptInput.value = lastSubmittedPrompt;
        setUploadStatus("发送失败，文本已保留。");
      }
      if (message.payload.goHome) {
        currentSessionExited = true;
        setConnectedState("detached");
        window.setTimeout(showStartScreen, 500);
      }
    }
  });

  nextSocket.addEventListener("close", (event) => {
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

function submitPrompt(deliveryMode = "auto") {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  if (notificationTarget.app === "agent") {
    void ensureAgentPushSubscription({ requestPermission: true }).catch(logPushRegistrationError);
  }
  if (
    send({
      type: "submit",
      data: prompt,
      deliveryMode,
      notificationApp: notificationTarget.app,
      notificationDeviceId: pushDeviceId,
    })
  ) {
    lastSubmittedPrompt = prompt;
    promptInput.value = "";
    setUploadStatus("正在发送…");
  } else {
    setUploadStatus("连接恢复中，文本已保留。");
  }
}

function handleControlAck(payload = {}) {
  if (payload.kind === "agent-response") {
    setUploadStatus("已提交给 Codex。", { clear: true });
    return;
  }
  if (payload.kind !== "submit") return;
  lastSubmittedPrompt = "";
  if (payload.turnState) renderTurnState(payload.turnState);
  const message = {
    new: "已开始新任务。",
    steer: "已追加到当前任务；不会替换前面的要求。",
    queue: "已排到下一轮。",
    "queue-fallback": "当前任务刚刚结束，已自动转到下一轮。",
  }[payload.deliveryMode];
  if (message) setUploadStatus(message, { clear: true });
}

function renderAgentRequest(payload = {}) {
  pendingAgentRequest = payload;
  agentRequestTitle.textContent = payload.title || "Codex 需要确认";
  agentRequestDetail.textContent = payload.detail || payload.method || "";
  const isQuestion = payload.kind === "question";
  const unsupported = payload.kind === "unsupported";
  agentRequestAnswer.classList.toggle("hidden", !isQuestion);
  agentRequestAnswer.value = "";
  if (isQuestion) {
    const options = (payload.questions || []).flatMap((question) => question.options || []).map((option) => option.label);
    agentRequestAnswer.placeholder = options.length ? `可选：${options.join(" / ")}；也可以直接输入` : "输入回答";
  }
  agentRequestAccept.textContent = isQuestion ? "提交回答" : "允许一次";
  agentRequestAccept.classList.toggle("hidden", unsupported);
  agentRequestSession.classList.toggle("hidden", isQuestion || unsupported);
  agentRequest.classList.remove("hidden");
}

function respondToAgentRequest(decision) {
  if (!pendingAgentRequest) return;
  const answer = agentRequestAnswer.value.trim();
  if (pendingAgentRequest.kind === "question" && !answer) {
    agentRequestAnswer.focus();
    return;
  }
  if (
    send({
      type: "agent-response",
      requestId: pendingAgentRequest.requestId,
      decision,
      answer,
    })
  ) {
    setUploadStatus("正在提交确认…");
  }
}

function clearAgentRequest() {
  pendingAgentRequest = null;
  agentRequest.classList.add("hidden");
  agentRequestAnswer.value = "";
}

function command(value) {
  send({
    type: "command",
    data: value,
    notificationApp: notificationTarget.app,
    notificationDeviceId: pushDeviceId,
  });
}

function sendTerminalKey(value) {
  send({
    type: "input",
    data: value,
    notificationApp: notificationTarget.app,
    notificationDeviceId: pushDeviceId,
  });
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
    revision: lastOutputRevision,
    savedAt: Date.now(),
  };
  trimSessionSnapshots(snapshots);
  writeSessionSnapshots(snapshots);
}

function restoreSessionSnapshot(key) {
  if (!terminal || !key) return false;

  const snapshot = readSessionSnapshots()[key];
  if (!snapshot?.text) return false;

  lastOutputRevision = validOutputRevision(snapshot.revision) ?? 0;
  queuedOutputRevision = lastOutputRevision;
  terminal.write(snapshot.text.replace(/\n/g, "\r\n"), () => {
    terminal.scrollToBottom();
    if (!textView.classList.contains("hidden")) {
      refreshTerminalText({ follow: true });
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
    const value = localStorage.getItem(SESSION_SNAPSHOT_STORE_KEY) || sessionStorage.getItem(SESSION_SNAPSHOT_STORE_KEY);
    if (!value) return {};
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeSessionSnapshots(snapshots) {
  try {
    localStorage.setItem(SESSION_SNAPSHOT_STORE_KEY, JSON.stringify(snapshots));
  } catch {
    try {
      sessionStorage.setItem(SESSION_SNAPSHOT_STORE_KEY, JSON.stringify(snapshots));
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
    if (document.visibilityState === "hidden") {
      saveActiveSessionSnapshot();
      return;
    }
    refreshTerminalDisplay();
    ensureVisibleConnection("visibility-visible", { probe: true });
  });
  window.addEventListener("pageshow", (event) => {
    logClientEvent("pageshow", { persisted: event.persisted });
    refreshTerminalDisplay();
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

function reconnectIfStale(reason, { replay = true } = {}) {
  if (!activeSessionId || currentSessionExited || sessionScreen.classList.contains("hidden")) return false;
  if (!connectionLooksStale()) return false;

  logClientEvent("force-reconnect", { reason, staleMs: Date.now() - lastServerSeenAt });
  openSocket(currentReconnectParams(), { reconnect: true, replay });
  return true;
}

function ensureVisibleConnection(reason, { probe = false, replay = true } = {}) {
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
    transport: activeSessionParams.transport || params.get("transport") || "terminal",
    access: activeSessionParams.access || params.get("access") || "safe",
    purpose: activeSessionParams.purpose || (params.get("purpose") === "think" ? "think" : ""),
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

function getNotificationTarget() {
  const params = new URLSearchParams(window.location.search);
  const deviceId = cleanNotificationDeviceId(params.get("notificationDeviceId"));
  if (params.get("notificationApp") === "home" && deviceId) {
    return { app: "home", deviceId };
  }
  return { app: "agent", deviceId: getPushDeviceId() };
}

function cleanNotificationDeviceId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, 80);
}

function appendNotificationTarget(url) {
  if (notificationTarget.app !== "home") return;
  url.searchParams.set("notificationApp", "home");
  url.searchParams.set("notificationDeviceId", notificationTarget.deviceId);
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
    transport: status.transport || "terminal",
    access: status.access || "safe",
    purpose: status.purpose === "think" ? "think" : "",
  };
  activeTransport = status.transport === "app-server" ? "app-server" : "terminal";
  activeAccessMode = status.access === "full" ? "full" : "safe";
  activeSessionReady = status.ready !== false;
  document.body.classList.toggle("app-server-session", activeTransport === "app-server");
  updateSessionViewLabels();
  currentSessionExited = Boolean(status.exited);
  const sessionLabel = status.title || displayProject(status.project);
  statusEls.project.textContent = sessionLabel;
  statusEls.project.title = sessionLabel;
  setConnectedState(status.exited ? "exited" : !activeSessionReady ? "starting" : historySyncPending ? "loading" : "connected");
  setDocumentTitle(status.title || displayProject(status.project));
  renderTurnState(status.turnState);
  syncPrimarySessionView();
  if (activeTransport === "app-server" && appTranscriptItems.length) {
    renderAppTranscript({ follow: isAppTranscriptAtBottom() });
  }
  syncSessionUrl(status);
}

function renderTurnState(value = {}) {
  latestTurnState = {
    active: Boolean(value.active),
    turnId: String(value.turnId || ""),
    requirements: Array.isArray(value.requirements) ? value.requirements : [],
    queuedTurns: Array.isArray(value.queuedTurns) ? value.queuedTurns : [],
  };
  const items = [...latestTurnState.requirements, ...latestTurnState.queuedTurns];
  const hasFailedItem = items.some((item) => item.status === "failed");
  const shouldShowLedger = items.length > 0 && (latestTurnState.active || hasFailedItem);
  turnLedger.classList.toggle("hidden", !shouldShowLedger);
  if (!shouldShowLedger) turnLedger.open = false;
  const itemCount = items.length ? ` · ${items.length} 项` : "";
  turnLedgerStatus.textContent = latestTurnState.active
    ? latestTurnState.queuedTurns.length
      ? `进行中 · ${latestTurnState.queuedTurns.length} 条待下一轮${itemCount}`
      : `进行中${itemCount}`
    : hasFailedItem
      ? `有未完成${itemCount}`
      : `已完成${itemCount}`;
  turnRequirements.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement("li");
      row.dataset.status = item.status || "working";
      const prefix = item.status === "queued" ? "下一轮：" : item.kind === "followup" ? "追加：" : "";
      row.textContent = `${prefix}${item.text || ""}`;
      return row;
    }),
  );
  sendPromptButton.textContent = latestTurnState.active ? "追加当前" : "新任务";
  queuePromptButton.classList.toggle("hidden", !latestTurnState.active);
}

function setConnectedState(state) {
  const connectionStates = {
    connected: "已连接",
    connecting: "连接中",
    reconnecting: "重新连接中",
    starting: "启动中",
    loading: "恢复中",
    detached: "已离开",
    exited: "已停止",
  };
  const transport = activeTransport === "app-server" ? "App Server · " : "Terminal · ";
  const access = activeAccessMode === "full" ? " · 全部允许" : " · 按需确认";
  const stateLabel = connectionStates[state] || state;
  statusEls.connection.textContent = `${transport}${stateLabel}${access}`;
  const connected = state === "connected" && activeSessionReady;
  sendPromptButton.disabled = !connected;
  queuePromptButton.disabled = !connected;
  textTabButton.disabled = !connected;
  pageUpButton.disabled = !connected;
  pageDownButton.disabled = !connected;
  keyUpButton.disabled = !connected;
  keyDownButton.disabled = !connected;
  keyEnterButton.disabled = !connected;
  keyEscButton.disabled = !connected;
  sendStatusButton.disabled = !connected;
  sendPermissionsButton.disabled = !connected;
  killSessionButton.disabled = !["connected", "starting", "loading"].includes(state);
}

function showStartScreen() {
  saveActiveSessionSnapshot();
  setSessionPageMode(false);
  setDocumentTitle(DEFAULT_DOCUMENT_TITLE);
  clearSessionUrl();
  startScreen.classList.remove("hidden");
  sessionScreen.classList.add("hidden");
  document.body.classList.remove("app-server-session");
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
  setSessionPageMode(true);
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
    url.searchParams.get("title") === title &&
    (status.transport === "app-server"
      ? url.searchParams.get("transport") === "app-server"
      : !url.searchParams.has("transport")) &&
    (status.access === "full" ? url.searchParams.get("access") === "full" : !url.searchParams.has("access")) &&
    (status.purpose === "think" ? url.searchParams.get("purpose") === "think" : !url.searchParams.has("purpose"));
  if (alreadySynced) return;

  url.search = "";
  url.searchParams.set("attach", status.id);
  url.searchParams.set("cwd", cwd);
  if (status.sessionId) url.searchParams.set("sessionId", status.sessionId);
  if (title) url.searchParams.set("title", title);
  if (status.transport === "app-server") url.searchParams.set("transport", "app-server");
  if (status.access === "full") url.searchParams.set("access", "full");
  if (status.purpose === "think") url.searchParams.set("purpose", "think");
  appendNotificationTarget(url);
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
  if (activeTransport === "app-server" && !appServerView.classList.contains("hidden")) {
    const overlap = Math.min(160, appServerView.clientHeight * PAGE_SCROLL_OVERLAP_RATIO);
    appServerView.scrollBy({ top: direction * Math.max(1, appServerView.clientHeight - overlap), behavior: "smooth" });
    return;
  }
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
  if (activeTransport === "app-server" && !appServerView.classList.contains("hidden")) {
    appServerView.scrollTo({ top: appServerView.scrollHeight, behavior: "smooth" });
    return;
  }
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
    const line = buffer.getLine(i);
    const text = line?.translateToString(true) || "";
    if (line?.isWrapped && lines.length) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines.join("\n").trimEnd();
}

function refreshTerminalDisplay() {
  if (!terminal || sessionScreen.classList.contains("hidden") || !textView.classList.contains("hidden")) return;
  resetSessionDocumentScroll();
  fitTerminal();
  requestAnimationFrame(() => terminal?.refresh(0, Math.max(0, terminal.rows - 1)));
}

function setSessionPageMode(active) {
  document.documentElement.classList.toggle("session-active", active);
  document.body.classList.toggle("session-active", active);
  if (active) resetSessionDocumentScroll();
}

function resetSessionDocumentScroll() {
  if (sessionScreen.classList.contains("hidden")) return;
  if (document.scrollingElement) {
    document.scrollingElement.scrollTop = 0;
    document.scrollingElement.scrollLeft = 0;
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });
}

function handleTerminalOutput(payload = {}) {
  const revision = validOutputRevision(payload.revision);
  if (revision !== null) {
    if (revision <= queuedOutputRevision) return;
    if (!historySyncPending && queuedOutputRevision > 0 && revision > queuedOutputRevision + 1) {
      logClientEvent("output-gap", {
        expectedRevision: queuedOutputRevision + 1,
        receivedRevision: revision,
      });
      openSocket(currentReconnectParams(), { reconnect: true });
      return;
    }
    queuedOutputRevision = revision;
  }
  writeTerminalOutput(payload.raw || "", { revision });
}

function writeTerminalOutput(raw, { replay = false, revision = null, onComplete } = {}) {
  if (!terminal) return;

  const shouldFollow = replay || isTerminalAtBottom();
  const previousViewportY = terminal.buffer.active.viewportY;
  terminal?.write(raw, () => {
    if (revision !== null) lastOutputRevision = Math.max(lastOutputRevision, revision);
    if (shouldFollow) {
      terminal.scrollToBottom();
    } else {
      terminal.scrollToLine(previousViewportY);
    }
    if (!textView.classList.contains("hidden")) {
      refreshTerminalText({ follow: shouldFollow });
    }
    onComplete?.();
  });
}

function writeTerminalReplay(payload = {}) {
  if (!terminal) return;

  const mode = payload.mode === "delta" ? "delta" : "full";
  const revision = validOutputRevision(payload.revision);
  const raw = String(payload.raw || "");

  if (mode === "delta") {
    if (revision !== null) queuedOutputRevision = Math.max(queuedOutputRevision, revision);
    if (!raw) {
      if (revision !== null) lastOutputRevision = Math.max(lastOutputRevision, revision);
      finishHistorySync(mode, raw.length);
      return;
    }
    writeTerminalOutput(raw, {
      replay: true,
      revision,
      onComplete: () => finishHistorySync(mode, raw.length),
    });
    return;
  }

  queuedOutputRevision = revision ?? 0;
  terminal.write(`\x1bc${raw}`, () => {
    lastOutputRevision = revision ?? 0;
    terminal.scrollToBottom();
    if (!textView.classList.contains("hidden")) {
      refreshTerminalText({ follow: true });
    }
    finishHistorySync(mode, raw.length);
  });
}

function finishHistorySync(mode, rawChars) {
  historySyncPending = false;
  setConnectedState(socket?.readyState === WebSocket.OPEN ? "connected" : "detached");
  logClientEvent("history-sync-complete", {
    replayMode: mode,
    rawChars,
    outputRevision: lastOutputRevision,
    durationMs: historySyncStartedAt ? Date.now() - historySyncStartedAt : 0,
  });
  historySyncStartedAt = 0;
  saveActiveSessionSnapshot();
}

function validOutputRevision(value) {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function isTerminalAtBottom() {
  if (!terminal) return true;
  const buffer = terminal.buffer.active;
  return buffer.viewportY >= buffer.baseY - 1;
}

function openTextView() {
  if (!terminal) return;

  terminalView.classList.add("hidden");
  appServerView.classList.add("hidden");
  textView.classList.remove("hidden");
  terminalTabButton.classList.remove("active");
  textTabButton.classList.add("active");
  refreshTerminalText({ follow: true });
}

function refreshTerminalText({ follow = false } = {}) {
  const wasAtBottom =
    terminalText.scrollHeight <= terminalText.clientHeight ||
    terminalText.scrollTop + terminalText.clientHeight >= terminalText.scrollHeight - 24;
  terminalText.value = getTerminalBufferText();
  if (!follow && !wasAtBottom) return;
  requestAnimationFrame(() => {
    terminalText.scrollTop = terminalText.scrollHeight;
  });
}

function closeTextView() {
  if (!terminalView || !appServerView || !textView) return;

  textView.classList.add("hidden");
  terminalView.classList.toggle("hidden", activeTransport === "app-server");
  appServerView.classList.toggle("hidden", activeTransport !== "app-server");
  textTabButton.classList.remove("active");
  terminalTabButton.classList.add("active");
  if (activeTransport === "app-server") {
    requestAnimationFrame(() => {
      appServerView.scrollTop = appServerView.scrollHeight;
    });
  } else {
    fitTerminal();
  }
}

function updateSessionViewLabels() {
  const isAppServer = activeTransport === "app-server";
  terminalTabButton.textContent = isAppServer ? "对话" : "Terminal";
  textTabButton.textContent = isAppServer ? "原始" : "Text";
  terminalTabButton.setAttribute("aria-label", isAppServer ? "查看整理后的对话" : "查看终端");
  textTabButton.setAttribute("aria-label", isAppServer ? "查看 App Server 原始文本" : "查看纯文本");
}

function syncPrimarySessionView() {
  if (!textView.classList.contains("hidden")) return;
  terminalView.classList.toggle("hidden", activeTransport === "app-server");
  appServerView.classList.toggle("hidden", activeTransport !== "app-server");
  if (activeTransport === "app-server" && !appTranscriptItems.length) renderAppTranscript();
}

function replaceAppTranscript(payload = {}) {
  appTranscriptItems = Array.isArray(payload.items) ? payload.items.map(normalizeClientTranscriptItem) : [];
  restoredAppTurnCount = Number.isFinite(payload.restoredTurnCount) ? payload.restoredTurnCount : 0;
  renderAppTranscript({ follow: true });
}

function upsertAppTranscript(payload = {}) {
  const item = normalizeClientTranscriptItem(payload);
  if (!item.id) return;
  const index = appTranscriptItems.findIndex((entry) => entry.id === item.id);
  const wasAtBottom = isAppTranscriptAtBottom();
  if (index >= 0) {
    const previousItem = appTranscriptItems[index];
    appTranscriptItems[index] = { ...previousItem, ...item };
    if (isProcessTranscriptItem(previousItem) || isProcessTranscriptItem(appTranscriptItems[index])) {
      renderAppTranscript({ follow: wasAtBottom });
    } else {
      replaceAppTranscriptCard(appTranscriptItems[index]);
    }
    followAppTranscriptIfNeeded(wasAtBottom);
    return;
  }
  appTranscriptItems.push(item);
  renderAppTranscript({ follow: wasAtBottom });
}

function appendAppTranscriptDelta(payload = {}) {
  if (!payload.id || !["text", "detail", "output"].includes(payload.field) || !payload.delta) return;
  const item = appTranscriptItems.find((entry) => entry.id === payload.id);
  if (!item) return;
  const wasAtBottom = isAppTranscriptAtBottom();
  item[payload.field] = trimClientTranscriptValue(`${item[payload.field] || ""}${payload.delta}`);
  if (isProcessTranscriptItem(item) && payload.field === "text") renderAppTranscript({ follow: wasAtBottom });
  else replaceAppTranscriptCard(item);
  followAppTranscriptIfNeeded(wasAtBottom);
}

function normalizeClientTranscriptItem(item = {}) {
  return {
    id: String(item.id || ""),
    type: String(item.type || "notice"),
    label: String(item.label || "状态"),
    text: trimClientTranscriptValue(item.text),
    detail: trimClientTranscriptValue(item.detail),
    output: trimClientTranscriptValue(item.output),
    status: String(item.status || ""),
    tone: String(item.tone || ""),
    phase: String(item.phase || ""),
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null,
    turnId: String(item.turnId || ""),
    turnStartedAt: Number.isFinite(item.turnStartedAt) ? item.turnStartedAt : null,
  };
}

function trimClientTranscriptValue(value) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= 200_000) return text;
  return `${text.slice(0, 130_000)}\n\n… 中间内容已折叠 …\n\n${text.slice(-70_000)}`;
}

function renderAppTranscript({ follow = false } = {}) {
  if (!appServerTranscript) return;
  const shouldFollow = follow || isAppTranscriptAtBottom();
  const fragment = document.createDocumentFragment();

  if (restoredAppTurnCount > 0) {
    const banner = document.createElement("div");
    banner.className = "app-history-banner";
    const title = document.createElement("strong");
    title.textContent = `已恢复 ${restoredAppTurnCount} 轮历史`;
    banner.append(title);
    fragment.append(banner);
  }

  if (!appTranscriptItems.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "app-transcript-empty";
    const title = document.createElement("strong");
    title.textContent = activeSessionReady ? "还没有对话" : "正在恢复会话…";
    const note = document.createElement("span");
    note.textContent = activeSessionReady ? "在下面输入内容，第一条消息会显示在这里。" : "历史内容准备好后会自动显示。";
    emptyState.append(title, note);
    fragment.append(emptyState);
  } else {
    let previousTurnId = "";
    for (let index = 0; index < appTranscriptItems.length; index += 1) {
      const item = appTranscriptItems[index];
      if (item.turnId && previousTurnId && item.turnId !== previousTurnId) {
        fragment.append(createAppTurnDivider(item));
      }
      if (isProcessTranscriptItem(item)) {
        const processItems = [item];
        while (
          index + 1 < appTranscriptItems.length &&
          isProcessTranscriptItem(appTranscriptItems[index + 1]) &&
          appTranscriptItems[index + 1].turnId === item.turnId
        ) {
          processItems.push(appTranscriptItems[index + 1]);
          index += 1;
        }
        fragment.append(createAppProcessGroup(processItems));
      } else {
        fragment.append(createAppTranscriptCard(item));
      }
      if (item.turnId) previousTurnId = item.turnId;
    }
  }

  appServerTranscript.replaceChildren(fragment);
  if (shouldFollow) followAppTranscriptIfNeeded(true);
}

function isProcessTranscriptItem(item) {
  return ["command", "plan", "file", "tool"].includes(item.type);
}

function createAppProcessGroup(items) {
  const group = document.createElement("details");
  group.className = "app-process-group";
  const groupId = `${items[0]?.turnId || "turn"}:${items[0]?.id || "process"}`;
  group.open = openAppProcessGroups.has(groupId);
  group.addEventListener("toggle", () => {
    if (group.open) openAppProcessGroups.add(groupId);
    else openAppProcessGroups.delete(groupId);
  });
  const summary = document.createElement("summary");
  const activeItem = [...items].reverse().find(isRunningTranscriptItem);
  const currentItem = activeItem || items.at(-1);
  const isActive = Boolean(activeItem);
  group.classList.toggle("is-active", isActive);

  const indicator = document.createElement("span");
  indicator.className = "app-activity-indicator";
  indicator.setAttribute("aria-hidden", "true");
  if (isActive) {
    indicator.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  } else {
    indicator.textContent = "✓";
  }

  const label = document.createElement("strong");
  label.textContent = isActive ? "正在" : "完成";
  const message = document.createElement("span");
  message.className = "app-activity-message";
  message.textContent = appActivityText(currentItem);
  message.title = message.textContent;
  const count = document.createElement("span");
  count.className = "app-activity-count";
  count.textContent = items.length > 1 ? `${items.length} 项` : "详情";
  summary.append(indicator, label, message, count);
  const content = document.createElement("div");
  content.className = "app-process-content";
  content.append(...items.map(createAppTranscriptCard));
  group.append(summary, content);
  return group;
}

function isRunningTranscriptItem(item) {
  return ["inProgress", "in_progress", "running"].includes(item?.status);
}

function appActivityText(item = {}) {
  const textLines = String(item.text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const planLine = textLines.find((line) => line.startsWith("→"));
  const content = planLine || textLines[0] || "处理中";
  if (item.type === "file") {
    const fileMatch = content.match(/^(新增|删除|修改|移动)\s*·\s*(.+)$/);
    if (fileMatch) return `${fileMatch[1]}文件 · ${fileMatch[2]}`;
  }
  const prefixes = {
    command: "运行命令",
    plan: "更新计划",
    file: "处理文件",
    tool: item.label === "协作" ? "协作处理" : item.label === "网页搜索" ? "搜索网页" : "使用工具",
  };
  const prefix = prefixes[item.type] || "处理";
  const normalized = content.replace(/^[✓→○]\s*/, "").replace(/\s+/g, " ");
  return normalized === prefix ? prefix : `${prefix} · ${normalized}`;
}

function createAppTurnDivider(item) {
  const divider = document.createElement("div");
  divider.className = "app-turn-divider";
  const line = document.createElement("span");
  const label = document.createElement("time");
  label.textContent = item.turnStartedAt ? formatTranscriptTime(item.turnStartedAt) : "下一轮";
  divider.append(line, label, line.cloneNode());
  return divider;
}

function createAppTranscriptCard(item) {
  const card = document.createElement("article");
  card.className = `app-transcript-item app-transcript-${clientTranscriptType(item.type)}`;
  if (item.type === "assistant" && item.phase && item.phase !== "final_answer") {
    card.classList.add("app-transcript-commentary");
  }
  card.dataset.transcriptId = item.id;

  const header = document.createElement("header");
  const identity = document.createElement("strong");
  identity.textContent = item.label;
  const metaText = transcriptMetaText(item);
  header.append(identity);
  if (metaText) {
    const meta = document.createElement("span");
    meta.textContent = metaText;
    header.append(meta);
  }
  card.append(header);

  if (item.text) {
    const copy = document.createElement(item.type === "command" ? "code" : "div");
    copy.className = item.type === "command" ? "app-transcript-command-text" : "app-transcript-copy";
    copy.textContent = item.text;
    card.append(copy);
  }

  if (item.detail) {
    card.append(createTranscriptDetails("查看详情", item.detail, item.type === "notice"));
  }
  if (item.output) {
    const lines = item.output.split("\n").length;
    const shouldOpen = (item.exitCode !== null && item.exitCode !== 0) || (item.output.length < 700 && lines <= 12);
    card.append(createTranscriptDetails(`查看输出 · ${lines} 行`, item.output, shouldOpen));
  }
  return card;
}

function createTranscriptDetails(summaryText, content, open = false) {
  const details = document.createElement("details");
  details.className = "app-transcript-details";
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const pre = document.createElement("pre");
  pre.textContent = content;
  details.append(summary, pre);
  return details;
}

function replaceAppTranscriptCard(item) {
  const existing = [...appServerTranscript.querySelectorAll("[data-transcript-id]")].find(
    (element) => element.dataset.transcriptId === item.id,
  );
  if (!existing) {
    renderAppTranscript({ follow: isAppTranscriptAtBottom() });
    return;
  }
  const openDetails = [...existing.querySelectorAll("details")].map((details) => details.open);
  const replacement = createAppTranscriptCard(item);
  [...replacement.querySelectorAll("details")].forEach((details, index) => {
    if (openDetails[index] !== undefined) details.open = openDetails[index];
  });
  existing.replaceWith(replacement);
}

function clientTranscriptType(type) {
  return ["user", "assistant", "command", "plan", "file", "tool", "notice"].includes(type) ? type : "notice";
}

function transcriptMetaText(item) {
  const values = [];
  const statuses = {
    inProgress: "进行中",
    in_progress: "进行中",
    running: "进行中",
    completed: "已完成",
    complete: "已完成",
    failed: "失败",
    declined: "已拒绝",
  };
  if (item.type === "assistant" && item.phase && item.phase !== "final_answer") values.push("过程说明");
  if (statuses[item.status]) values.push(statuses[item.status]);
  if (item.exitCode !== null) values.push(`退出码 ${item.exitCode}`);
  if (item.durationMs !== null) values.push(formatTranscriptDuration(item.durationMs));
  return values.join(" · ");
}

function formatTranscriptDuration(durationMs) {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatTranscriptTime(unixSeconds) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(unixSeconds * 1_000));
}

function isAppTranscriptAtBottom() {
  if (!appServerView || appServerView.classList.contains("hidden")) return true;
  return appServerView.scrollTop + appServerView.clientHeight >= appServerView.scrollHeight - 72;
}

function followAppTranscriptIfNeeded(shouldFollow) {
  if (!shouldFollow || !appServerView) return;
  requestAnimationFrame(() => {
    appServerView.scrollTop = appServerView.scrollHeight;
  });
}

function ensureTerminal() {
  if (terminal) return;

  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: 13,
    scrollback: 12000,
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
  const transport = status.transport === "app-server" ? "app server · " : "";
  if (status.sessionId) return `${transport}resumed`;
  if (status.mode === "resume-last") return `${transport}resume last`;
  return `${transport}new session`;
}

function formatTime(value) {
  if (!value) return "-";
  return agentDateTimeFormatter.format(new Date(value));
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
  for (const key of ["attach", "cwd", "sessionId", "title", "purpose"]) {
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
