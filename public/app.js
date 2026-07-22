const startScreen = document.querySelector("#start-screen");
const sessionScreen = document.querySelector("#session-screen");
const projectSelect = document.querySelector("#project");
const launchModeSelect = document.querySelector("#launch-mode");
const transportSelect = document.querySelector("#transport");
const accessModeSelect = document.querySelector("#access-mode");
const sessionIdInput = document.querySelector("#session-id");
const connectButton = document.querySelector("#connect");
const startThinkButton = document.querySelector("#start-think");
const openMemoriesButton = document.querySelector("#open-memories");
const refreshSessionsButton = document.querySelector("#refresh-sessions");
const restartAgentButton = document.querySelector("#restart-agent");
const restartAgentLabel = document.querySelector("#restart-agent-label");
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
const appSessionPermissionsButton = document.querySelector("#app-session-permissions");
const appSessionPermissionsValue = document.querySelector("#app-session-permissions-value");
const appSessionMemoriesButton = document.querySelector("#app-session-memories");
const appSessionMemoryProjects = document.querySelector("#app-session-memory-projects");
const appSessionTaskControl = document.querySelector("#app-session-task-control");
const appSessionTaskState = document.querySelector("#app-session-task-state");
const appSessionTaskStop = document.querySelector("#app-session-task-stop");
const killSessionButton = document.querySelector("#kill-session");
const attachFileButton = document.querySelector("#attach-file");
const voiceInputButton = document.querySelector("#voice-input");
const sendPromptButton = document.querySelector("#send-prompt");
const queuePromptButton = document.querySelector("#queue-prompt");
const fileInput = document.querySelector("#file-input");
const promptInput = document.querySelector("#prompt");
const composer = document.querySelector("#composer");
const composerAttachments = document.querySelector("#composer-attachments");
const composerSuggestions = document.querySelector("#composer-suggestions");
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
const terminalSessionPreview = document.querySelector("#terminal-session-preview");
const terminalSessionPreviewResult = document.querySelector("#terminal-session-preview-result");
const terminalSessionPreviewDismiss = document.querySelector("#terminal-session-preview-dismiss");
const appServerView = document.querySelector("#app-server-view");
const appServerTranscript = document.querySelector("#app-server-transcript");
const textView = document.querySelector("#text-view");
const terminalText = document.querySelector("#terminal-text");
const appCommandDialog = document.querySelector("#app-command-dialog");
const appCommandEyebrow = document.querySelector("#app-command-eyebrow");
const appCommandTitle = document.querySelector("#app-command-title");
const appCommandContent = document.querySelector("#app-command-content");
const appCommandActions = document.querySelector("#app-command-actions");
const appCommandClose = document.querySelector("#app-command-close");

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
const AGENT_RESTART_ENDPOINT = "https://home.chenyanglin.com/api/system/agent/restart";
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
const TERMINAL_RECENT_HISTORY_MAX_CHARS = 24_000;
const TERMINAL_HISTORY_QUIET_MS = 1_200;
const TERMINAL_HISTORY_EMPTY_READY_MS = 120;
const TERMINAL_DELAYED_HISTORY_GUARD_MS = 60_000;
const APP_INITIAL_TURN_LIMIT = 10;
const APP_COMMANDS = [
  { name: "/status", description: "完整 Session 状态、上下文与额度" },
  { name: "/usage", description: "查看一周额度、重置时间与 Token 活动" },
  { name: "/permissions", description: "切换按需确认或全部允许" },
  { name: "/model", description: "查看或切换模型与 reasoning" },
  { name: "/fast", description: "切换 Fast 模式" },
  { name: "/skills", description: "浏览并插入可用 Skill" },
  { name: "/goal", description: "查看或设置当前长期 Goal" },
  { name: "/rename", description: "重命名当前 Session", requiresArgument: true },
  { name: "/compact", description: "压缩上下文，释放容量" },
  { name: "/copy", description: "复制最近一次完整回答", clientOnly: true },
  { name: "/memories", description: "查看个人记忆、项目规则与审批记录", clientOnly: true },
  { name: "/diff", description: "查看工作区未提交修改" },
  { name: "/review", description: "Review 当前未提交修改" },
  { name: "/mcp", description: "查看已连接的 MCP Server" },
  { name: "/plugins", description: "查看 Plugin 安装状态" },
  { name: "/hooks", description: "查看当前工作区 Hooks" },
];
const appMarkdownRenderer = globalThis.AgentMarkdown?.createRenderer() || null;

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
let loadedAgentInstance = "";
let agentInstanceCheckPending = false;
let reconnectAttempts = 0;
let activeSessionId = "";
let activeSessionParams = {};
let currentSessionExited = false;
let lastServerSeenAt = 0;
let historySyncPending = false;
let historySyncStartedAt = 0;
let lastOutputRevision = 0;
let queuedOutputRevision = 0;
let terminalHistoryBuffering = false;
let terminalHistoryForceFull = false;
let terminalHistoryWaitForOutput = false;
let terminalHistoryChunks = [];
let terminalHistoryChars = 0;
let terminalHistoryRevision = null;
let terminalHistoryFlushTimer = null;
let terminalHistoryUiReady = false;
let uploadStatusTimer = null;
let liveSessionsByCodexId = new Map();
let archivedSessionsExpanded = false;
let latestTurnState = {
  active: false,
  stopping: false,
  interrupted: false,
  interruptedAt: "",
  turnId: "",
  lastCompletedTurnId: "",
  lastStoppedTurnId: "",
  requirements: [],
  queuedTurns: [],
};
let resumeInterruptedPending = false;
let interruptRequestPending = false;
let activeTransport = "terminal";
let activeAccessMode = "safe";
let activeMemoryProjectMode = "auto";
let activeMemoryProjects = [];
let activeMemoryProjectSource = "global";
let activeSessionReady = true;
let activeStartupQueueSupported = false;
let activeTurnInterruptSupported = false;
let pendingAgentRequest = null;
let lastSubmittedPrompt = "";
let lastSubmittedAttachments = [];
let pendingResumeSession = null;
let appTranscriptItems = [];
let restoredAppTurnCount = 0;
let restoredAppHistoryHasMore = false;
let restoredAppHistoryLoading = false;
let appTranscriptSource = "";
let cachedSessionPreview = null;
let sessionPreviewRequestSequence = 0;
let terminalPreviewAllowed = false;
let terminalOutputWhilePreviewChars = 0;
let appSkills = [];
let appSkillsRequested = false;
let suggestionItems = [];
let activeSuggestionIndex = 0;
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

syncStartSelectionsFromUrl(new URLSearchParams(window.location.search));
window.addEventListener("resize", () => fitTerminal({ delay: 120 }));

logoutButton.addEventListener("click", logout);
restartAgentButton.addEventListener("click", restartAgentWeb);
connectButton.addEventListener("click", () => startSession());
startThinkButton.addEventListener("click", startThinkSession);
openMemoriesButton.addEventListener("click", openMemoryManager);
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
appSessionPermissionsButton.addEventListener("click", () => runAppCommand("/permissions"));
appSessionMemoriesButton.addEventListener("click", openMemoryManager);
appSessionTaskControl.addEventListener("click", interruptCurrentTurn);
killSessionButton.addEventListener("click", endSession);
terminalSessionPreviewDismiss.addEventListener("click", hideTerminalSessionPreview);
appCommandClose.addEventListener("click", () => appCommandDialog.close());
appCommandDialog.addEventListener("click", (event) => {
  if (event.target === appCommandDialog) appCommandDialog.close();
});
sendPromptButton.addEventListener("click", () => submitPrompt("auto"));
queuePromptButton.addEventListener("click", () => submitPrompt("queue"));
agentRequestAccept.addEventListener("click", () => respondToAgentRequest("accept"));
agentRequestSession.addEventListener("click", () => respondToAgentRequest("acceptForSession"));
agentRequestDecline.addEventListener("click", () => respondToAgentRequest("decline"));
promptInput.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (handleSuggestionKeydown(event)) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitPrompt("auto");
  }
});
promptInput.addEventListener("input", updateComposerSuggestions);
promptInput.addEventListener("focus", updateComposerSuggestions);
const uploadController = window.AgentUpload.create({
  attachButton: attachFileButton,
  fileInput,
  composer,
  attachmentsHost: composerAttachments,
  setUploadStatus,
  redirectToLogin,
});
uploadController.install();
const voiceInputController = window.AgentVoiceInput.create({
  button: voiceInputButton,
  promptInput,
  setUploadStatus,
  getRecoveryContext: () => activeSessionId || activeSessionParams.sessionId || "",
});
voiceInputController.install();
installPageDownLongPress();
installClientEventLogging();

bootstrap().catch(() => {
  redirectToLogin();
});

async function bootstrap() {
  const response = await fetch("/api/auth");
  const data = await response.json();
  if (data.authenticated) {
    loadedAgentInstance = await readAgentInstance();
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

async function restartAgentWeb() {
  const confirmed = window.confirm("重启 Agent Web？所有页面会短暂断连，正在运行的任务可能中断。");
  if (!confirmed) return;

  restartAgentButton.disabled = true;
  restartAgentLabel.textContent = "准备重启";
  try {
    const previousInstance = await readAgentInstance();
    const response = await fetch(AGENT_RESTART_ENDPOINT, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`restart request failed (${response.status})`);

    restartAgentLabel.textContent = "正在重启";
    const recovered = await waitForAgentRestart(previousInstance);
    if (!recovered) throw new Error("Agent did not return in time");
    window.location.reload();
  } catch (error) {
    restartAgentButton.disabled = false;
    restartAgentLabel.textContent = "重启";
    window.alert(`重启失败：${error.message}`);
  }
}

async function readAgentInstance() {
  try {
    const response = await fetch(`/healthz?time=${Date.now()}`, { cache: "no-store" });
    return response.ok ? response.headers.get("X-Agent-Instance") || "" : "";
  } catch {
    return "";
  }
}

async function reloadAfterAgentUpgrade() {
  if (agentInstanceCheckPending) return;
  agentInstanceCheckPending = true;
  try {
    const currentInstance = await readAgentInstance();
    if (!currentInstance) return;
    if (!loadedAgentInstance) {
      loadedAgentInstance = currentInstance;
      return;
    }
    if (currentInstance !== loadedAgentInstance) window.location.reload();
  } finally {
    agentInstanceCheckPending = false;
  }
}

async function waitForAgentRestart(previousInstance) {
  const deadline = Date.now() + 30_000;
  let unavailable = false;
  await wait(500);

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`/healthz?time=${Date.now()}`, { cache: "no-store" });
      const currentInstance = response.headers.get("X-Agent-Instance") || "";
      if (response.ok && (unavailable || (currentInstance && currentInstance !== previousInstance))) return true;
    } catch {
      unavailable = true;
    }
    await wait(250);
  }
  return false;
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
    sessionsList.append(empty("No live sessions. Detached sessions stay available for about 30 minutes."));
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
  resumeAccessMode.value = session.access === "full" ? "full" : "safe";
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
  const hasSessionIdOverride = Object.prototype.hasOwnProperty.call(overrides, "sessionId");
  const sessionId = hasSessionIdOverride ? String(overrides.sessionId || "").trim() : sessionIdInput.value.trim();
  const params = {
    cwd: overrides.cwd || projectSelect.value,
    mode: overrides.mode || (sessionId ? "new" : launchModeSelect.value),
    sessionId,
    transport: overrides.transport || transportSelect.value || "terminal",
    purpose: overrides.purpose === "think" ? "think" : "",
  };
  const access = overrides.access || (!sessionId ? accessModeSelect.value || "safe" : "");
  if (access) params.access = access;
  openSocket(params);
}

function startThinkSession() {
  startSession({
    cwd: ".",
    mode: "new",
    sessionId: "",
    transport: transportSelect.value || "terminal",
    access: accessModeSelect.value || "safe",
    purpose: "think",
  });
}

function syncStartSelectionsFromUrl(params) {
  if (params.has("transport")) {
    transportSelect.value = params.get("transport") === "app-server" ? "app-server" : "terminal";
  }
  if (params.has("access")) {
    accessModeSelect.value = params.get("access") === "full" ? "full" : "safe";
  }
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
  const access = params.has("access") ? (params.get("access") === "full" ? "full" : "safe") : "";
  const purpose = params.get("purpose") === "think" ? "think" : "";
  syncStartSelectionsFromUrl(params);
  const launch = {
    cwd: params.get("cwd") || ".",
    sessionId,
    transport,
    purpose,
  };
  if (access) launch.access = access;

  if (title) setDocumentTitle(title);

  if (attach) {
    attachSession(attach, launch);
    return true;
  }

  if (sessionId) {
    startSession(launch);
    return true;
  }

  if (startNew) {
    startSession({
      ...launch,
      mode: "new",
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
  activeTransport = params.transport === "app-server" ? "app-server" : "terminal";
  const hasSnapshot = !isReconnect && hasSessionSnapshot(snapshotKey);
  const shouldReplay = options.replay !== false;
  const resumesTerminalHistory =
    Boolean(params.sessionId) || ["resume-last", "resume-picker"].includes(params.mode);
  beginTerminalHistoryBuffer({
    active: shouldReplay && activeTransport === "terminal",
    forceFull: !isReconnect && resumesTerminalHistory,
    waitForOutput: !isReconnect && resumesTerminalHistory && !params.attach,
  });
  if (!isReconnect) {
    terminal?.reset();
    latestTurnState = {
      active: false,
      stopping: false,
      interrupted: false,
      interruptedAt: "",
      turnId: "",
      lastCompletedTurnId: "",
      lastStoppedTurnId: "",
      requirements: [],
      queuedTurns: [],
    };
    resumeInterruptedPending = false;
    interruptRequestPending = false;
    appTranscriptItems = [];
    restoredAppTurnCount = 0;
    restoredAppHistoryHasMore = false;
    restoredAppHistoryLoading = false;
    appTranscriptSource = "";
    cachedSessionPreview = null;
    appSkills = [];
    appSkillsRequested = false;
    activeMemoryProjectMode = "auto";
    activeMemoryProjects = [];
    activeMemoryProjectSource = "global";
    hideComposerSuggestions();
    hideTerminalSessionPreview();
    terminalPreviewAllowed = activeTransport === "terminal" && !hasSnapshot && resumesTerminalHistory;
    sessionPreviewRequestSequence += 1;
    openAppProcessGroups.clear();
    renderAppTranscript();
    lastOutputRevision = 0;
    queuedOutputRevision = 0;
    if (hasSnapshot) restoreSessionSnapshot(snapshotKey);
    if (params.sessionId) {
      void loadSessionPreview(params.sessionId, sessionPreviewRequestSequence);
    }
  }
  historySyncPending = shouldReplay;
  historySyncStartedAt = shouldReplay ? Date.now() : 0;
  activeAccessMode = params.access === "full" ? "full" : params.access === "safe" ? "safe" : "";
  activeSessionReady = activeTransport !== "app-server";
  activeStartupQueueSupported = false;
  activeTurnInterruptSupported = false;
  syncAppSessionToolbar();
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
    void reloadAfterAgentUpgrade();
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
    if (message.type === "app-history-state") {
      restoredAppHistoryLoading = Boolean(message.payload?.loadingEarlier);
      renderAppTranscript({ follow: false });
      return;
    }
    if (message.type === "app-command-result") {
      renderAppCommandResult(message.payload);
      return;
    }
    if (message.type === "app-skills") {
      receiveAppSkills(message.payload);
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
      if (resumeInterruptedPending) {
        resumeInterruptedPending = false;
        renderAppTranscript({ follow: false });
      }
      if (interruptRequestPending) {
        interruptRequestPending = false;
        latestTurnState.stopping = false;
        syncAppSessionToolbar();
      }
      terminal?.writeln(`\r\n${message.payload.message}\r\n`);
      if (activeTransport === "app-server") setUploadStatus(message.payload.message);
      if (appCommandDialog.open && !message.payload.preservePrompt) {
        showAppCommandDialog({ title: appCommandTitle.textContent || "Command", content: message.payload.message });
      }
      if (message.payload.preservePrompt && (lastSubmittedPrompt || lastSubmittedAttachments.length)) {
        if (lastSubmittedPrompt && !promptInput.value.trim()) promptInput.value = lastSubmittedPrompt;
        uploadController.restoreAttachments(lastSubmittedAttachments);
        setUploadStatus("发送失败，文字和附件已保留。");
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
  const attachments = uploadController.getAttachments();
  if (!prompt && !attachments.length) return;
  if (!attachments.length && activeTransport === "app-server" && runAppComposerCommand(prompt)) return;
  if (notificationTarget.app === "agent") {
    void ensureAgentPushSubscription({ requestPermission: true }).catch(logPushRegistrationError);
  }
  if (
    send({
      type: "submit",
      data: prompt,
      attachments,
      deliveryMode,
      skills: activeTransport === "app-server" ? extractSkillMentions(prompt) : [],
      notificationApp: notificationTarget.app,
      notificationDeviceId: pushDeviceId,
    })
  ) {
    lastSubmittedPrompt = prompt;
    lastSubmittedAttachments = attachments;
    promptInput.value = "";
    uploadController.clearAttachments();
    hideComposerSuggestions();
    setUploadStatus("正在发送…");
  } else {
    setUploadStatus("连接恢复中，文本已保留。");
  }
}

function handleControlAck(payload = {}) {
  if (["submit", "startup-submit"].includes(payload.kind)) void voiceInputController.discardStoredRecovery();
  if (payload.kind === "access") {
    activeAccessMode = payload.access === "full" ? "full" : "safe";
    activeSessionParams.access = activeAccessMode;
    syncAppSessionToolbar();
    setUploadStatus(`已切换为${appAccessLabel(payload.access)}。`, { clear: true });
    return;
  }
  if (payload.kind === "memory-projects") {
    activeMemoryProjectMode = payload.mode === "manual" ? "manual" : "auto";
    activeMemoryProjects = normalizeSessionMemoryProjects(payload.projects);
    syncMemoryProjectLabel();
    setUploadStatus("当前 Session 的项目记忆已更新。", { clear: true });
    return;
  }
  if (payload.kind === "agent-response") {
    setUploadStatus("已提交给 Codex。", { clear: true });
    return;
  }
  if (payload.kind === "resume-interrupted") {
    resumeInterruptedPending = false;
    if (payload.turnState) renderTurnState(payload.turnState);
    setUploadStatus("已继续刚才中断的任务。", { clear: true });
    return;
  }
  if (payload.kind === "interrupt-turn") {
    setUploadStatus("正在终止当前任务…", { clear: true });
    return;
  }
  if (payload.kind === "startup-submit") {
    lastSubmittedPrompt = "";
    lastSubmittedAttachments = [];
    if (payload.turnState) renderTurnState(payload.turnState);
    const skills = activeSkillAckText(payload.skills);
    setUploadStatus(`会话已恢复，任务已经开始。${skills}`, { clear: true });
    return;
  }
  if (payload.kind !== "submit") return;
  if (payload.deliveryMode !== "startup-queue") {
    lastSubmittedPrompt = "";
    lastSubmittedAttachments = [];
  }
  if (payload.turnState) renderTurnState(payload.turnState);
  const message = {
    new: "已开始新任务。",
    steer: "已追加到当前任务；不会替换前面的要求。",
    queue: "已排到下一轮。",
    "queue-fallback": "当前任务刚刚结束，已自动转到下一轮。",
    "startup-queue": "已排队；会话恢复后会自动开始。",
  }[payload.deliveryMode];
  if (message) setUploadStatus(`${message}${activeSkillAckText(payload.skills)}`, { clear: true });
}

function activeSkillAckText(skills) {
  return Array.isArray(skills) && skills.length ? ` 已启用：${skills.map((name) => `$${name}`).join("、")}。` : "";
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
  if (activeTransport === "app-server") {
    runAppCommand(value);
    return;
  }
  send({
    type: "command",
    data: value,
    notificationApp: notificationTarget.app,
    notificationDeviceId: pushDeviceId,
  });
}

function runAppComposerCommand(prompt) {
  const commandName = String(prompt || "").trim().split(/\s+/)[0].toLowerCase();
  if (!APP_COMMANDS.some((item) => item.name === commandName)) return false;
  promptInput.value = "";
  hideComposerSuggestions();
  runAppCommand(prompt);
  return true;
}

function runAppCommand(value) {
  const commandText = String(value || "").trim();
  const commandName = commandText.split(/\s+/)[0].toLowerCase();
  if (!commandName) return;
  if (commandName === "/copy") {
    void copyLatestAppAnswer();
    return;
  }
  if (commandName === "/memories") {
    openMemoryManager();
    return;
  }
  if (commandName === "/status") {
    showAppCommandDialog({ title: "Session status", content: "正在读取真实 App Server 状态…" });
  } else if (commandName === "/usage") {
    showAppCommandDialog({ title: "Account usage", content: "正在读取额度和 Token 活动…" });
  } else if (commandName === "/permissions") {
    showAppCommandDialog({ title: "Permissions", content: "正在读取当前权限…" });
  } else if (commandName === "/skills") {
    if (!appSkills.length) showAppCommandDialog({ title: "Skills", content: "正在读取可用 Skills…" });
  } else {
    const title = APP_COMMANDS.find((item) => item.name === commandName)?.name || commandName;
    showAppCommandDialog({ title, content: "正在读取…" });
  }
  if (!send({ type: "command", data: commandText })) {
    setUploadStatus("连接恢复中，命令尚未发送。");
  }
}

function openMemoryManager(event) {
  const sessionRouting =
    activeTransport === "app-server" &&
    activeSessionId &&
    (!sessionScreen.classList.contains("hidden") || event?.currentTarget === appSessionMemoriesButton);
  globalThis.AgentMemories?.open({
    project: activeSessionParams.cwd || projectSelect.value,
    ...(sessionRouting
      ? {
          projects: activeMemoryProjects,
          mode: activeMemoryProjectMode,
          source: activeMemoryProjectSource,
          onProjectChange: updateMemoryProjectSelection,
        }
      : {}),
  });
}

function updateMemoryProjectSelection(selection = {}) {
  const mode = selection.mode === "manual" ? "manual" : "auto";
  const projects = normalizeSessionMemoryProjects(selection.projects);
  activeMemoryProjectMode = mode;
  activeMemoryProjects = projects;
  activeMemoryProjectSource = mode === "manual" ? "manual" : projects.length ? "retained" : "global";
  syncMemoryProjectLabel();
  if (!send({ type: "set-memory-projects", mode, projects })) {
    setUploadStatus("连接恢复中，记忆项目尚未修改。", { clear: true });
  }
}

function renderAppCommandResult(payload = {}) {
  if (payload.kind === "permissions") {
    renderAppPermissions(payload);
    return;
  }
  if (payload.kind === "usage") {
    renderAppUsage(payload);
    return;
  }
  if (payload.kind === "models") {
    renderAppModels(payload);
    return;
  }
  if (payload.kind === "goal") {
    renderAppGoal(payload);
    return;
  }
  if (payload.kind === "inventory") {
    showAppCommandDialog({
      title: payload.title || "Inventory",
      rows: (payload.items || []).map((item) => [item.name, item.detail]),
      content: payload.items?.length ? "" : "没有可显示的项目。",
      note: payload.note || "",
    });
    return;
  }
  if (payload.kind === "notice") {
    showAppCommandDialog({ title: payload.title || "App Server", content: payload.content || "已完成。" });
    return;
  }
  if (payload.kind === "text") {
    showAppCommandDialog({
      title: payload.title || "Output",
      content: payload.content || "没有输出。",
      note: payload.note || "",
      preformatted: true,
    });
    return;
  }
  if (payload.kind !== "status") return;

  const rows = [
    ["Account", formatAppAccount(payload.account)],
    ["Session", payload.title || "未命名"],
    ["Session ID", payload.sessionId || "尚未建立"],
    ["Codex", payload.cliVersion ? `v${payload.cliVersion}` : "未知"],
    ["Engine", payload.engine || "App Server"],
    ["Model", [payload.model, payload.reasoningEffort].filter(Boolean).join(" · ")],
    ["Provider", payload.modelProvider || "default"],
    ["Service tier", payload.serviceTier === "priority" ? "Fast" : payload.serviceTier || "default"],
    ["Directory", payload.cwd || payload.project || "."],
    ["Permissions", appAccessLabel(payload.access)],
    ["Approval", payload.approvalPolicy || "-"],
    ["Sandbox", payload.sandbox || "-"],
    ["Writable roots", (payload.writableRoots || []).join("\n") || "未知"],
    ["Network", payload.networkAccess || "未知"],
    ["AGENTS.md", (payload.agentsFiles || []).join("\n") || "未发现"],
    ["Turn", payload.activeTurn ? "正在处理" : "空闲"],
  ];
  if (payload.sessionCliVersion && payload.sessionCliVersion !== payload.cliVersion) {
    rows.splice(4, 0, ["Session created with", `v${payload.sessionCliVersion}`]);
  }
  if (payload.gitBranch) rows.splice(9, 0, ["Git branch", payload.gitBranch]);
  if (payload.tokenUsage) {
    const contextWindow = Number(payload.tokenUsage.modelContextWindow || 0);
    const contextUsed = Number(payload.tokenUsage.contextUsedTokens || 0);
    const contextRemaining = contextWindow ? Math.max(0, Math.round((1 - contextUsed / contextWindow) * 100)) : null;
    rows.push(
      ["Tokens", `${formatCount(payload.tokenUsage.totalTokens)} total`],
      ["Input / output", `${formatCount(payload.tokenUsage.inputTokens)} / ${formatCount(payload.tokenUsage.outputTokens)}`],
      ["Cached input", formatCount(payload.tokenUsage.cachedInputTokens)],
      ["Reasoning output", formatCount(payload.tokenUsage.reasoningOutputTokens)],
      [
        "Context window",
        contextRemaining === null
          ? "未知"
          : `${contextRemaining}% 剩余（${formatCount(contextUsed)} / ${formatCount(contextWindow)}）`,
      ],
    );
  } else {
    rows.push(["Tokens", "恢复后尚未收到本线程 Token 更新"]);
  }
  if (payload.resetCredits) rows.push(["Limit resets", `${payload.resetCredits} 次可用`]);
  showAppCommandDialog({ title: "Session status", meters: appRateLimitMeters(payload.rateLimits), rows });
}

function renderAppUsage(payload = {}) {
  const summary = payload.activitySummary || {};
  const dailyUsage = Array.isArray(payload.dailyUsage) ? payload.dailyUsage : [];
  const sevenDayTokens = dailyUsage.reduce((total, item) => total + Number(item.tokens || 0), 0);
  const rows = [
    ["Account", formatAppAccount(payload.account)],
    ["过去 7 天 Tokens", formatCount(sevenDayTokens)],
    ["Lifetime Tokens", formatCount(summary.lifetimeTokens)],
    ["当前连续使用", summary.currentStreakDays ? `${summary.currentStreakDays} 天` : "未知"],
    ["最长连续使用", summary.longestStreakDays ? `${summary.longestStreakDays} 天` : "未知"],
    ["单日峰值", formatCount(summary.peakDailyTokens)],
    ["最长单轮", summary.longestRunningTurnSec ? formatElapsedSeconds(summary.longestRunningTurnSec) : "未知"],
    ["Limit resets", payload.resetCredits ? `${payload.resetCredits} 次可用` : "无"],
  ];
  for (const item of dailyUsage) rows.push([item.startDate || "日期未知", `${formatCount(item.tokens)} tokens`]);
  showAppCommandDialog({
    title: "Account usage",
    meters: appRateLimitMeters(payload.rateLimits),
    rows,
    note: "额度条显示官方返回的使用窗口；Token 活动是账户统计，不等于当前 Session 的上下文占用。",
  });
}

function renderAppModels(payload = {}) {
  const models = Array.isArray(payload.models) ? payload.models : [];
  showAppCommandDialog({
    title: "Model",
    rows: [
      ["Current", `${payload.currentModel || "default"} · ${payload.currentReasoningEffort || "default"}`],
      ["Available", `${models.length} 个模型`],
    ],
    note: payload.activeTurn
      ? "当前任务已经开始；新模型会从下一轮任务生效。需要指定 reasoning 时可输入：/model 模型名 high"
      : "选择后从下一轮任务生效。需要指定 reasoning 时可输入：/model 模型名 high",
    actions: models.map((model) => ({
      label: model.id === payload.currentModel ? `${model.name} · 当前` : model.name,
      primary: model.id === payload.currentModel,
      action: () => runAppCommand(`/model ${model.id}`),
    })),
  });
}

function renderAppGoal(payload = {}) {
  const goal = payload.goal;
  showAppCommandDialog({
    title: "Goal",
    content: goal?.objective || "当前 Session 没有 Goal。",
    rows: goal
      ? [
          ["Status", goal.status || "active"],
          ["Tokens", formatCount(goal.tokensUsed)],
          ["Time", formatElapsedSeconds(goal.timeUsedSeconds)],
        ]
      : [],
    note: "设置：/goal 目标内容　清除：/goal clear",
  });
}

async function copyLatestAppAnswer() {
  const answer = [...appTranscriptItems]
    .reverse()
    .find((item) => item.type === "assistant" && item.text && (!item.phase || item.phase === "final_answer"));
  if (!answer?.text) {
    setUploadStatus("当前没有可复制的完整回答。", { clear: true });
    return;
  }
  try {
    await navigator.clipboard.writeText(answer.text);
    setUploadStatus("已复制最近一次完整回答。", { clear: true });
  } catch {
    showAppCommandDialog({ title: "Latest answer", content: answer.text, preformatted: true });
  }
}

function renderAppPermissions(payload = {}) {
  const activeNote = payload.activeTurn ? "当前任务已经开始；新权限会从下一轮任务生效。" : "新权限会从下一轮任务生效。";
  showAppCommandDialog({
    title: "Permissions",
    rows: [
      ["Current", appAccessLabel(payload.access)],
      ["Scope", payload.access === "full" ? "服务器全部文件与网络" : "工作区写入，越界时确认"],
    ],
    note: activeNote,
    actions: [
      {
        label: "按需确认",
        primary: payload.access !== "safe",
        action: () => setAppAccess("safe"),
      },
      {
        label: "全部允许",
        danger: true,
        primary: payload.access !== "full",
        action: () => setAppAccess("full"),
      },
    ],
  });
}

function setAppAccess(access) {
  if (!send({ type: "set-access", access })) return;
  appCommandDialog.close();
  setUploadStatus(`正在切换为${appAccessLabel(access)}…`);
}

function showAppCommandDialog({
  title,
  content = "",
  meters = [],
  rows = [],
  note = "",
  actions = [],
  preformatted = false,
}) {
  appCommandEyebrow.textContent = "App Server";
  appCommandTitle.textContent = title;
  const fragment = document.createDocumentFragment();
  if (content) {
    const message = document.createElement(preformatted ? "pre" : "p");
    message.className = preformatted ? "app-command-output" : "app-command-message";
    message.textContent = content;
    fragment.append(message);
  }
  if (meters.length) {
    const meterList = document.createElement("section");
    meterList.className = "app-command-meters";
    for (const meter of meters) {
      const card = document.createElement("article");
      const heading = document.createElement("header");
      const name = document.createElement("strong");
      name.textContent = meter.label;
      const value = document.createElement("span");
      value.textContent = `${meter.remainingPercent}% 剩余`;
      heading.append(name, value);
      const track = document.createElement("div");
      track.className = "app-command-meter-track";
      const fill = document.createElement("i");
      fill.style.width = `${meter.usedPercent}%`;
      track.append(fill);
      const detail = document.createElement("p");
      detail.textContent = `${meter.usedPercent}% 已使用${meter.resetText ? ` · ${meter.resetText}` : ""}`;
      card.append(heading, track, detail);
      meterList.append(card);
    }
    fragment.append(meterList);
  }
  if (rows.length) {
    const list = document.createElement("dl");
    list.className = "app-command-status";
    for (const [label, value] of rows) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = String(value || "-");
      list.append(term, detail);
    }
    fragment.append(list);
  }
  if (note) {
    const copy = document.createElement("p");
    copy.className = "app-command-note";
    copy.textContent = note;
    fragment.append(copy);
  }
  appCommandContent.replaceChildren(fragment);
  appCommandActions.replaceChildren(
    ...actions.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      if (item.primary) button.classList.add("primary");
      if (item.danger) button.classList.add("danger");
      button.addEventListener("click", item.action);
      return button;
    }),
  );
  appCommandActions.classList.toggle("hidden", !actions.length);
  if (!appCommandDialog.open) appCommandDialog.showModal();
}

function updateComposerSuggestions() {
  if (activeTransport !== "app-server") {
    hideComposerSuggestions();
    return;
  }
  const beforeCaret = promptInput.value.slice(0, promptInput.selectionStart ?? promptInput.value.length);
  if (/^\/[^\s]*$/.test(beforeCaret)) {
    const query = beforeCaret.toLowerCase();
    const items = APP_COMMANDS.filter((item) => item.name.startsWith(query)).map((item) => ({
      type: "command",
      label: item.name,
      detail: item.description,
      command: item,
    }));
    if (items.length) renderComposerSuggestions(items, "Commands");
    else hideComposerSuggestions();
    return;
  }
  const skillMatch = beforeCaret.match(/(?:^|\s)\$([a-zA-Z0-9_:-]*)$/);
  if (!skillMatch) {
    hideComposerSuggestions();
    return;
  }
  if (!appSkills.length) {
    if (!activeSessionReady) {
      renderSuggestionLoading("会话恢复后会自动读取 Skills…");
      return;
    }
    if (!appSkillsRequested) {
      appSkillsRequested = true;
      send({ type: "skills-list" });
    }
    renderSuggestionLoading("正在读取 Skills…");
    return;
  }
  const query = skillMatch[1].toLowerCase();
  const items = appSkills
    .filter((skill) => skill.name.toLowerCase().includes(query))
    .slice(0, 50)
    .map((skill) => ({ type: "skill", label: `$${skill.name}`, detail: skill.description, skill }));
  renderComposerSuggestions(items, "Skills");
}

function renderComposerSuggestions(items, label) {
  suggestionItems = items;
  activeSuggestionIndex = Math.min(activeSuggestionIndex, Math.max(0, items.length - 1));
  const header = document.createElement("header");
  header.textContent = label;
  const fragment = document.createDocumentFragment();
  fragment.append(header);
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "没有匹配项";
    fragment.append(empty);
  } else {
    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "option";
      button.dataset.index = String(index);
      button.classList.toggle("active", index === activeSuggestionIndex);
      const name = document.createElement("strong");
      name.textContent = item.label;
      const detail = document.createElement("span");
      detail.textContent = item.detail || "";
      button.append(name, detail);
      button.addEventListener("pointerdown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectComposerSuggestion(index));
      fragment.append(button);
    });
  }
  composerSuggestions.replaceChildren(fragment);
  composerSuggestions.classList.remove("hidden");
}

function renderSuggestionLoading(message) {
  suggestionItems = [];
  const header = document.createElement("header");
  header.textContent = "Skills";
  const loading = document.createElement("p");
  loading.textContent = message;
  composerSuggestions.replaceChildren(header, loading);
  composerSuggestions.classList.remove("hidden");
}

function receiveAppSkills(payload = {}) {
  appSkills = (Array.isArray(payload.skills) ? payload.skills : []).sort((left, right) => left.name.localeCompare(right.name));
  appSkillsRequested = true;
  if (payload.openPicker) {
    if (appCommandDialog.open) appCommandDialog.close();
    promptInput.value = "$";
    promptInput.focus();
    promptInput.setSelectionRange(1, 1);
  }
  updateComposerSuggestions();
}

function selectComposerSuggestion(index) {
  const item = suggestionItems[index];
  if (!item) return;
  if (item.type === "command") {
    if (item.command?.requiresArgument) {
      promptInput.value = `${item.label} `;
      const nextCaret = promptInput.value.length;
      promptInput.setSelectionRange(nextCaret, nextCaret);
      promptInput.focus();
      hideComposerSuggestions();
      return;
    }
    promptInput.value = "";
    hideComposerSuggestions();
    runAppCommand(item.label);
    return;
  }
  const caret = promptInput.selectionStart ?? promptInput.value.length;
  const beforeCaret = promptInput.value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)\$[a-zA-Z0-9_:-]*$/);
  if (!match) return;
  const tokenOffset = match[0].lastIndexOf("$");
  const start = (match.index || 0) + tokenOffset;
  const inserted = `$${item.skill.name} `;
  promptInput.value = `${promptInput.value.slice(0, start)}${inserted}${promptInput.value.slice(caret)}`;
  const nextCaret = start + inserted.length;
  promptInput.setSelectionRange(nextCaret, nextCaret);
  promptInput.focus();
  hideComposerSuggestions();
}

function handleSuggestionKeydown(event) {
  if (composerSuggestions.classList.contains("hidden")) return false;
  if (event.key === "Escape") {
    event.preventDefault();
    hideComposerSuggestions();
    return true;
  }
  if (!suggestionItems.length) return false;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    activeSuggestionIndex = (activeSuggestionIndex + delta + suggestionItems.length) % suggestionItems.length;
    renderComposerSuggestions(suggestionItems, suggestionItems[0]?.type === "skill" ? "Skills" : "Commands");
    composerSuggestions.querySelector("button.active")?.scrollIntoView({ block: "nearest" });
    return true;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    selectComposerSuggestion(activeSuggestionIndex);
    return true;
  }
  return false;
}

function hideComposerSuggestions() {
  suggestionItems = [];
  activeSuggestionIndex = 0;
  composerSuggestions.classList.add("hidden");
  composerSuggestions.replaceChildren();
}

function extractSkillMentions(text) {
  const names = [];
  for (const match of String(text || "").matchAll(/(?:^|\s)\$([a-zA-Z0-9][a-zA-Z0-9_:-]*)/g)) names.push(match[1]);
  return [...new Set(names)].slice(0, 8);
}

function appAccessLabel(access) {
  if (access === "full") return "全部允许";
  if (access === "safe") return "按需确认";
  return "读取中";
}

function syncAppSessionToolbar() {
  appSessionPermissionsButton.dataset.access = activeAccessMode;
  appSessionPermissionsValue.textContent = appAccessLabel(activeAccessMode);
  appSessionPermissionsButton.setAttribute("aria-label", `权限：${appAccessLabel(activeAccessMode)}`);
  syncMemoryProjectLabel();
  const canInterrupt =
    activeTransport === "app-server" &&
    activeTurnInterruptSupported &&
    latestTurnState.active &&
    !latestTurnState.stopping &&
    !interruptRequestPending;
  const taskState = appSessionTaskStateValue();
  appSessionTaskControl.disabled = !canInterrupt;
  appSessionTaskControl.dataset.state = taskState.value;
  appSessionTaskState.textContent = taskState.label;
  appSessionTaskStop.classList.toggle("hidden", !canInterrupt);
  appSessionTaskControl.title = canInterrupt ? "正在处理，点击停止当前任务" : `当前任务：${taskState.label}`;
  appSessionTaskControl.setAttribute(
    "aria-label",
    canInterrupt ? "当前任务正在处理，点击停止" : `当前任务：${taskState.label}`,
  );
}

function syncMemoryProjectLabel() {
  appSessionMemoryProjects.textContent = "自动运行";
  const runtime = appSessionMemoriesButton.dataset.memoryRuntimeTitle || "个人记忆自动运行中";
  appSessionMemoriesButton.title = `${runtime}；默认读取 Core 与 Now，项目规则由所在项目 AGENTS.md 提供`;
  appSessionMemoriesButton.setAttribute("aria-label", "记忆与规则：自动运行");
}

function normalizeSessionMemoryProjects(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 20);
}

function shortSessionMemoryProject(value) {
  return String(value || "").split("/").filter(Boolean).at(-1) || "项目";
}

function appSessionTaskStateValue() {
  if (!activeSessionReady) return { value: "connecting", label: "连接中" };
  if (latestTurnState.interrupted) return { value: "interrupted", label: "已中断" };
  if (latestTurnState.stopping || interruptRequestPending) return { value: "stopping", label: "正在停止" };
  if (latestTurnState.active) return { value: "working", label: "正在处理" };
  if (
    latestTurnState.lastStoppedTurnId &&
    latestTurnState.lastStoppedTurnId === latestTurnState.lastCompletedTurnId
  ) {
    return { value: "stopped", label: "已停止" };
  }
  return { value: "idle", label: "当前无任务" };
}

function interruptCurrentTurn() {
  if (
    activeTransport !== "app-server" ||
    !activeTurnInterruptSupported ||
    !latestTurnState.active ||
    latestTurnState.stopping
  ) {
    return;
  }
  interruptRequestPending = true;
  latestTurnState.stopping = true;
  syncAppSessionToolbar();
  if (!send({ type: "interrupt-turn" })) {
    interruptRequestPending = false;
    latestTurnState.stopping = false;
    syncAppSessionToolbar();
    setUploadStatus("连接恢复中，尚未终止任务。", { clear: true });
  }
}

function formatCount(value) {
  const number = Number(value || 0);
  return number ? new Intl.NumberFormat("zh-CN").format(number) : "0";
}

function formatAppAccount(account) {
  if (!account) return "未知";
  const plan = String(account.planType || "").replaceAll("_", " ");
  if (account.type === "apiKey") return "API key";
  return [account.email, plan ? plan.replace(/\b\w/g, (letter) => letter.toUpperCase()) : ""].filter(Boolean).join(" · ");
}

function appRateLimitMeters(rateLimits) {
  return (Array.isArray(rateLimits) ? rateLimits : [])
    .map((limit) => ({
      label: appRateLimitLabel(limit),
      usedPercent: Math.max(0, Math.min(100, Number(limit.usedPercent || 0))),
      remainingPercent: Math.max(0, 100 - Number(limit.usedPercent || 0)),
      resetText: limit.resetsAt ? `${formatUnixTime(limit.resetsAt)} 重置` : "",
      duration: Number(limit.windowDurationMins || 0),
    }))
    .sort((left, right) => left.duration - right.duration);
}

function appRateLimitLabel(limit) {
  const duration = Number(limit.windowDurationMins || 0);
  const windowLabel =
    duration === 300
      ? "5 小时额度"
      : duration === 10_080
        ? "一周额度"
        : duration >= 1_440 && duration % 1_440 === 0
          ? `${duration / 1_440} 天额度`
          : duration >= 60 && duration % 60 === 0
            ? `${duration / 60} 小时额度`
            : duration
              ? `${duration} 分钟额度`
              : "使用额度";
  return limit.limitName ? `${limit.limitName} · ${windowLabel}` : windowLabel;
}

function formatElapsedSeconds(value) {
  const seconds = Math.max(0, Number(value || 0));
  if (seconds < 60) return `${Math.round(seconds)} 秒`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(seconds / 3_600)} 小时 ${Math.round((seconds % 3_600) / 60)} 分`;
}

function formatUnixTime(value) {
  const date = new Date(Number(value) * 1_000);
  return Number.isNaN(date.getTime()) ? "未知" : agentDateTimeFormatter.format(date);
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
  window.clearTimeout(terminalHistoryFlushTimer);
  reconnectTimer = null;
  visibleProbeTimer = null;
  terminalHistoryFlushTimer = null;
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
  const recentText = snapshot.text.slice(-TERMINAL_RECENT_HISTORY_MAX_CHARS);
  terminalView.classList.add("replaying");
  terminal.write(recentText.replace(/\n/g, "\r\n"), () => {
    terminal.scrollToBottom();
    terminalView.classList.remove("replaying");
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

function setUploadStatus(message, { clear = false, actionLabel = "", onAction = null } = {}) {
  window.clearTimeout(uploadStatusTimer);
  uploadStatus.replaceChildren(document.createTextNode(message));
  if (actionLabel && typeof onAction === "function") {
    const action = document.createElement("button");
    action.type = "button";
    action.className = "upload-status-action";
    action.textContent = actionLabel;
    action.addEventListener("click", async () => {
      action.disabled = true;
      await onAction();
    });
    uploadStatus.append(action);
  }
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
  activeMemoryProjectMode = status.memoryProjectMode === "manual" ? "manual" : "auto";
  activeMemoryProjects = normalizeSessionMemoryProjects(status.memoryProjects);
  activeMemoryProjectSource = ["manual", "prompt", "retained", "cwd", "title", "global"].includes(status.memoryProjectSource)
    ? status.memoryProjectSource
    : "global";
  activeSessionReady = status.ready !== false;
  activeStartupQueueSupported = Boolean(status.capabilities?.startupQueue);
  activeTurnInterruptSupported = Boolean(status.capabilities?.interruptTurn);
  syncAppSessionToolbar();
  globalThis.AgentMemories?.updateSessionRouting({
    mode: activeMemoryProjectMode,
    projects: activeMemoryProjects,
    source: activeMemoryProjectSource,
  });
  document.body.classList.toggle("app-server-session", activeTransport === "app-server");
  updateSessionViewLabels();
  currentSessionExited = Boolean(status.exited);
  const sessionLabel = status.title || displayProject(status.project);
  statusEls.project.textContent = sessionLabel;
  statusEls.project.title = sessionLabel;
  setConnectedState(status.exited ? "exited" : !activeSessionReady ? "starting" : historySyncPending ? "loading" : "connected");
  setDocumentTitle(status.title || displayProject(status.project));
  renderTurnState(status.turnState);
  void voiceInputController.offerStoredRecovery();
  syncPrimarySessionView();
  if (activeTransport === "app-server" && appTranscriptItems.length) {
    renderAppTranscript({ follow: isAppTranscriptAtBottom() });
  }
  if (activeTransport === "app-server" && activeSessionReady && promptInput.value.includes("$")) {
    updateComposerSuggestions();
  }
  syncSessionUrl(status);
}

function renderTurnState(value = {}) {
  latestTurnState = {
    active: Boolean(value.active),
    interrupted: Boolean(value.interrupted),
    interruptedAt: String(value.interruptedAt || ""),
    stopping: Boolean(value.stopping),
    turnId: String(value.turnId || ""),
    lastCompletedTurnId: String(value.lastCompletedTurnId || ""),
    lastStoppedTurnId: String(value.lastStoppedTurnId || ""),
    requirements: Array.isArray(value.requirements) ? value.requirements : [],
    queuedTurns: Array.isArray(value.queuedTurns) ? value.queuedTurns : [],
  };
  if (!latestTurnState.active || !latestTurnState.stopping) interruptRequestPending = false;
  if (!latestTurnState.interrupted || latestTurnState.active) resumeInterruptedPending = false;
  const items = [...latestTurnState.requirements, ...latestTurnState.queuedTurns];
  const hasFailedItem = items.some((item) => item.status === "failed");
  const shouldShowLedger = items.length > 0 && (latestTurnState.active || latestTurnState.interrupted || hasFailedItem);
  turnLedger.classList.toggle("hidden", !shouldShowLedger);
  if (!shouldShowLedger) turnLedger.open = false;
  const itemCount = items.length ? ` · ${items.length} 项` : "";
  turnLedgerStatus.textContent = latestTurnState.interrupted
    ? `已中断${itemCount}`
    : latestTurnState.active
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
      const prefix =
        item.status === "interrupted"
          ? "中断："
          : item.status === "queued"
            ? "下一轮："
            : item.kind === "followup"
              ? "追加："
              : "";
      row.textContent = `${prefix}${item.text || ""}`;
      return row;
    }),
  );
  sendPromptButton.textContent = latestTurnState.active ? "追加当前" : "新任务";
  queuePromptButton.classList.toggle("hidden", !latestTurnState.active);
  syncAppSessionToolbar();
}

function setConnectedState(state) {
  const connectionStates = {
    connected: "已连接",
    connecting: "连接中",
    reconnecting: "重新连接中",
    starting: activeSessionParams.sessionId ? "恢复历史中 · 可先提交" : "启动中 · 可先提交",
    loading: "已连接 · 恢复最新记录中",
    detached: "已离开",
    exited: "已停止",
  };
  const transport = activeTransport === "app-server" ? "App Server · " : "Terminal · ";
  const access = activeAccessMode ? ` · ${appAccessLabel(activeAccessMode)}` : "";
  const stateLabel = connectionStates[state] || state;
  statusEls.connection.textContent = `${transport}${stateLabel}${access}`;
  const terminalCanAcceptInput =
    activeTransport === "terminal" &&
    ["connected", "loading"].includes(state) &&
    socket?.readyState === WebSocket.OPEN;
  const appServerCanQueueStartup =
    activeTransport === "app-server" &&
    activeStartupQueueSupported &&
    ["starting", "loading", "connected"].includes(state) &&
    socket?.readyState === WebSocket.OPEN;
  const connected = ((state === "connected" || terminalCanAcceptInput) && activeSessionReady) || appServerCanQueueStartup;
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
  appSessionPermissionsButton.disabled = activeTransport !== "app-server" || !connected;
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
  if (activeTransport === "terminal" && !terminalSessionPreview.classList.contains("hidden")) {
    terminalOutputWhilePreviewChars += String(payload.raw || "").length;
    if (terminalOutputWhilePreviewChars > 1_000) hideTerminalSessionPreview();
  }
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
  if (terminalHistoryBuffering && activeTransport === "terminal") {
    bufferTerminalHistory(payload.raw || "", { revision, forceFull: terminalHistoryForceFull });
    return;
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

  if (terminalHistoryBuffering && activeTransport === "terminal") {
    bufferTerminalHistory(raw, { revision, forceFull: mode === "full" });
    return;
  }

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

function beginTerminalHistoryBuffer({ active, forceFull = false, waitForOutput = false } = {}) {
  window.clearTimeout(terminalHistoryFlushTimer);
  terminalHistoryFlushTimer = null;
  terminalHistoryBuffering = Boolean(active);
  terminalHistoryForceFull = Boolean(forceFull);
  terminalHistoryWaitForOutput = Boolean(waitForOutput);
  terminalHistoryChunks = [];
  terminalHistoryChars = 0;
  terminalHistoryRevision = null;
  terminalHistoryUiReady = false;
}

function bufferTerminalHistory(raw, { revision = null, forceFull = false } = {}) {
  terminalHistoryForceFull ||= Boolean(forceFull);
  if (revision !== null) {
    terminalHistoryRevision = Math.max(terminalHistoryRevision ?? 0, revision);
    queuedOutputRevision = Math.max(queuedOutputRevision, revision);
  }

  if (raw) {
    if (terminalHistoryUiReady) {
      logClientEvent("terminal-history-late-output", {
        waitedMs: historySyncStartedAt ? Date.now() - historySyncStartedAt : 0,
      });
      terminalHistoryUiReady = false;
    }
    terminalHistoryWaitForOutput = false;
    terminalHistoryChunks.push(raw);
    terminalHistoryChars += raw.length;
    trimTerminalHistoryBuffer();
  }

  window.clearTimeout(terminalHistoryFlushTimer);
  if (terminalHistoryWaitForOutput && !terminalHistoryChars) {
    terminalHistoryFlushTimer = window.setTimeout(flushTerminalHistoryBuffer, TERMINAL_HISTORY_EMPTY_READY_MS);
    return;
  }
  terminalHistoryFlushTimer = window.setTimeout(flushTerminalHistoryBuffer, raw ? TERMINAL_HISTORY_QUIET_MS : 120);
}

function trimTerminalHistoryBuffer() {
  let trimmed = false;
  while (terminalHistoryChars > TERMINAL_RECENT_HISTORY_MAX_CHARS && terminalHistoryChunks.length > 1) {
    terminalHistoryChars -= terminalHistoryChunks.shift().length;
    trimmed = true;
  }
  if (terminalHistoryChars > TERMINAL_RECENT_HISTORY_MAX_CHARS && terminalHistoryChunks.length === 1) {
    terminalHistoryChunks[0] = terminalHistoryChunks[0].slice(-TERMINAL_RECENT_HISTORY_MAX_CHARS);
    terminalHistoryChars = terminalHistoryChunks[0].length;
    trimmed = true;
  }
  if (trimmed) terminalHistoryForceFull = true;
}

function flushTerminalHistoryBuffer() {
  window.clearTimeout(terminalHistoryFlushTimer);
  terminalHistoryFlushTimer = null;
  if (!terminalHistoryBuffering || !terminal) return;

  const raw = terminalHistoryChunks.join("");
  const rawChars = terminalHistoryChars;
  const revision = terminalHistoryRevision;
  const mode = terminalHistoryForceFull ? "recent" : "delta";

  if (!raw && terminalHistoryWaitForOutput) {
    exposeTerminalWhileHistoryIsPending();
    return;
  }

  terminalHistoryBuffering = false;
  terminalHistoryWaitForOutput = false;
  terminalHistoryChunks = [];
  terminalHistoryChars = 0;
  terminalHistoryRevision = null;

  if (!raw) {
    if (revision !== null) lastOutputRevision = Math.max(lastOutputRevision, revision);
    finishHistorySync(mode, 0);
    return;
  }

  terminalView.classList.add("replaying");
  const output = terminalHistoryForceFull ? `\x1bc${raw}` : raw;
  terminalHistoryForceFull = false;
  terminal.write(output, () => {
    if (revision !== null) lastOutputRevision = Math.max(lastOutputRevision, revision);
    terminal.scrollToBottom();
    terminalView.classList.remove("replaying");
    if (!textView.classList.contains("hidden")) refreshTerminalText({ follow: true });
    finishHistorySync(mode, rawChars);
  });
}

function exposeTerminalWhileHistoryIsPending() {
  historySyncPending = false;
  terminalHistoryUiReady = true;
  window.clearTimeout(terminalHistoryFlushTimer);
  terminalHistoryFlushTimer = window.setTimeout(disarmDelayedTerminalHistory, TERMINAL_DELAYED_HISTORY_GUARD_MS);
  setConnectedState(currentSocketConnectionState());
  logClientEvent("terminal-ui-ready", {
    waitingForDelayedHistory: true,
    outputRevision: lastOutputRevision,
    durationMs: historySyncStartedAt ? Date.now() - historySyncStartedAt : 0,
  });
}

function disarmDelayedTerminalHistory() {
  terminalHistoryFlushTimer = null;
  terminalHistoryBuffering = false;
  terminalHistoryWaitForOutput = false;
  terminalHistoryForceFull = false;
  terminalHistoryUiReady = false;
  historySyncStartedAt = 0;
  logClientEvent("terminal-history-guard-expired");
}

function finishHistorySync(mode, rawChars) {
  historySyncPending = false;
  terminalHistoryBuffering = false;
  terminalHistoryWaitForOutput = false;
  terminalHistoryForceFull = false;
  terminalHistoryUiReady = false;
  window.clearTimeout(terminalHistoryFlushTimer);
  terminalHistoryFlushTimer = null;
  terminalView.classList.remove("replaying");
  setConnectedState(currentSocketConnectionState());
  logClientEvent("history-sync-complete", {
    replayMode: mode,
    rawChars,
    outputRevision: lastOutputRevision,
    durationMs: historySyncStartedAt ? Date.now() - historySyncStartedAt : 0,
  });
  historySyncStartedAt = 0;
  if (activeTransport === "terminal" && rawChars > 1_000) hideTerminalSessionPreview();
  saveActiveSessionSnapshot();
}

function currentSocketConnectionState() {
  if (socket?.readyState !== WebSocket.OPEN) return "detached";
  if (activeTransport === "app-server" && !activeSessionReady) return "starting";
  return "connected";
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
  const prepended = Boolean(payload.prepended);
  const replacingDiskPreview = appTranscriptSource === "disk";
  const wasAtBottom = isAppTranscriptAtBottom();
  const previousScrollHeight = appServerView.scrollHeight;
  const previousScrollTop = appServerView.scrollTop;
  const allItems = Array.isArray(payload.items) ? payload.items : [];
  // A resumed App Server sends an empty transcript before its recent turns are
  // available. Do not let that placeholder win the race against disk history.
  if (!allItems.length && !activeSessionReady) return;
  appTranscriptItems = allItems.map(normalizeClientTranscriptItem);
  appTranscriptSource = "app-server";
  if (appTranscriptItems.length) cachedSessionPreview = null;
  const availableTurnCount = Number.isFinite(payload.restoredTurnCount) ? payload.restoredTurnCount : 0;
  restoredAppTurnCount = availableTurnCount;
  restoredAppHistoryHasMore = Boolean(payload.hasEarlierTurns);
  restoredAppHistoryLoading = Boolean(payload.loadingEarlier);
  renderAppTranscript({ follow: !prepended && (!replacingDiskPreview || wasAtBottom) });
  if (prepended) {
    requestAnimationFrame(() => {
      appServerView.scrollTop = previousScrollTop + (appServerView.scrollHeight - previousScrollHeight);
    });
  }
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
    attachments: normalizeClientAttachments(item.attachments),
    memoryCitation: normalizeClientMemoryCitation(item.memoryCitation),
  };
}

function normalizeClientAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .slice(0, 10)
    .map((attachment) => ({
      path: String(attachment?.path || ""),
      originalName: String(attachment?.originalName || attachment?.name || "附件"),
      mime: String(attachment?.mime || "application/octet-stream"),
      size: Number.isFinite(attachment?.size) ? attachment.size : null,
    }))
    .filter((attachment) => attachment.path);
}

function normalizeClientMemoryCitation(citation) {
  if (!citation || typeof citation !== "object") return null;
  const entries = (Array.isArray(citation.entries) ? citation.entries : [])
    .map((entry) => ({
      path: String(entry?.path || "").slice(0, 2_000),
      lineStart: Number.isFinite(entry?.lineStart) ? entry.lineStart : null,
      lineEnd: Number.isFinite(entry?.lineEnd) ? entry.lineEnd : null,
      note: String(entry?.note || "").slice(0, 4_000),
    }))
    .filter((entry) => entry.path || entry.note)
    .slice(0, 30);
  const threadIds = (Array.isArray(citation.threadIds) ? citation.threadIds : [])
    .map((threadId) => String(threadId || "").slice(0, 200))
    .filter(Boolean)
    .slice(0, 30);
  return entries.length || threadIds.length ? { entries, threadIds } : null;
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
    title.textContent =
      appTranscriptSource === "disk"
        ? `已从磁盘显示最近 ${restoredAppTurnCount} 轮`
        : `已加载最近 ${restoredAppTurnCount} 轮`;
    banner.append(title);
    if (appTranscriptSource === "disk") {
      const note = document.createElement("span");
      note.textContent = "App Server 正在后台连接";
      banner.append(note);
    } else if (restoredAppHistoryHasMore) {
      const loadEarlier = document.createElement("button");
      loadEarlier.type = "button";
      loadEarlier.className = "app-history-load";
      loadEarlier.disabled = restoredAppHistoryLoading;
      loadEarlier.textContent = restoredAppHistoryLoading ? "正在加载…" : `加载更早 ${APP_INITIAL_TURN_LIMIT} 轮`;
      loadEarlier.addEventListener("click", () => {
        restoredAppHistoryLoading = true;
        renderAppTranscript({ follow: false });
        if (!send({ type: "load-app-history" })) {
          restoredAppHistoryLoading = false;
          renderAppTranscript({ follow: false });
        }
      });
      banner.append(loadEarlier);
    } else {
      const note = document.createElement("span");
      note.textContent = "已到最早记录";
      banner.append(note);
    }
    fragment.append(banner);
  }

  if (!appTranscriptItems.length && cachedSessionPreview?.result) {
    const banner = document.createElement("div");
    banner.className = "app-history-banner app-preview-banner";
    const title = document.createElement("strong");
    title.textContent = "上次完成";
    const note = document.createElement("span");
    note.textContent = activeSessionReady ? "最近记录已恢复" : "完整会话正在后台连接";
    banner.append(title, note);
    fragment.append(banner);
    if (cachedSessionPreview.prompt) {
      fragment.append(
        createAppTranscriptCard({
          id: "session-preview-user",
          type: "user",
          label: "你",
          text: cachedSessionPreview.prompt,
          detail: "",
          output: "",
          status: "completed",
          tone: "",
          phase: "",
          durationMs: null,
          exitCode: null,
          turnId: "session-preview",
          turnStartedAt: null,
        }),
      );
    }
    fragment.append(
      createAppTranscriptCard({
        id: "session-preview-assistant",
        type: "assistant",
        label: "Codex",
        text: cachedSessionPreview.result,
        detail: "",
        output: "",
        status: "completed",
        tone: "",
        phase: "final_answer",
        durationMs: null,
        exitCode: null,
        turnId: "session-preview",
        turnStartedAt: null,
      }),
    );
  } else if (!appTranscriptItems.length) {
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

  if (latestTurnState.interrupted) fragment.append(createInterruptedTurnNotice());

  appServerTranscript.replaceChildren(fragment);
  if (shouldFollow) followAppTranscriptIfNeeded(true);
}

async function loadSessionPreview(sessionId, requestSequence) {
  try {
    const response = await fetch(`/api/session-preview/${encodeURIComponent(sessionId)}`);
    if (!response.ok) return;
    const data = await response.json();
    if (requestSequence !== sessionPreviewRequestSequence || activeSessionParams.sessionId !== sessionId) return;
    const preview = data.preview;
    if (preview?.result) {
      cachedSessionPreview = {
        prompt: String(preview.prompt || ""),
        result: String(preview.result || ""),
        completedAt: String(preview.completedAt || ""),
      };
    }
    if (activeTransport === "terminal") {
      renderTerminalSessionPreview();
    } else if (appTranscriptSource !== "app-server") {
      const diskItems = diskConversationItems(data.conversation);
      if (diskItems.length) {
        appTranscriptItems = diskItems;
        appTranscriptSource = "disk";
        restoredAppTurnCount = Array.isArray(data.conversation?.turns) ? data.conversation.turns.length : 0;
        restoredAppHistoryHasMore = Boolean(data.conversation?.hasEarlier);
        renderAppTranscript({ follow: true });
      } else if (!appTranscriptItems.length) {
        renderAppTranscript({ follow: true });
      }
    }
  } catch {}
}

function diskConversationItems(conversation = {}) {
  const items = [];
  for (const [turnIndex, turn] of (Array.isArray(conversation.turns) ? conversation.turns : []).entries()) {
    const turnId = String(turn.id || `disk-turn-${turnIndex + 1}`);
    const turnStartedAt = Date.parse(turn.startedAt || "");
    if (turn.user) {
      items.push(
        normalizeClientTranscriptItem({
          id: `${turnId}-user`,
          type: "user",
          label: "你",
          text: turn.user,
          status: "completed",
          turnId,
          turnStartedAt: Number.isFinite(turnStartedAt) ? turnStartedAt : null,
        }),
      );
    }
    for (const [answerIndex, answer] of (Array.isArray(turn.assistant) ? turn.assistant : []).entries()) {
      items.push(
        normalizeClientTranscriptItem({
          id: `${turnId}-assistant-${answerIndex + 1}`,
          type: "assistant",
          label: "Codex",
          text: answer.text,
          phase: answer.phase,
          status: "completed",
          turnId,
          turnStartedAt: Number.isFinite(turnStartedAt) ? turnStartedAt : null,
        }),
      );
    }
  }
  return items;
}

function renderTerminalSessionPreview() {
  if (!terminalPreviewAllowed || !cachedSessionPreview?.result) return;
  terminalOutputWhilePreviewChars = 0;
  terminalSessionPreviewResult.textContent = cachedSessionPreview.result;
  terminalSessionPreview.classList.remove("hidden");
}

function hideTerminalSessionPreview() {
  terminalPreviewAllowed = false;
  terminalOutputWhilePreviewChars = 0;
  terminalSessionPreview.classList.add("hidden");
}

function isProcessTranscriptItem(item) {
  return (
    ["command", "plan", "file", "tool"].includes(item.type) ||
    (item.type === "assistant" && item.phase !== "final_answer")
  );
}

function appTurnHasFinalAnswer(turnId) {
  return Boolean(
    turnId &&
      appTranscriptItems.some(
        (item) => item.turnId === turnId && item.type === "assistant" && item.phase === "final_answer" && item.text,
      ),
  );
}

function appTurnIsInterrupted(turnId) {
  return Boolean(latestTurnState.interrupted && turnId && latestTurnState.turnId === turnId);
}

function appTurnWasStopped(turnId) {
  return Boolean(turnId && latestTurnState.lastStoppedTurnId === turnId);
}

function createInterruptedTurnNotice() {
  const notice = document.createElement("section");
  notice.className = "app-interrupted-turn";
  notice.setAttribute("role", "status");

  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = "本轮已中断";
  const detail = document.createElement("span");
  detail.textContent = "服务重启前没有生成最终回复。继续时会先核对现状，避免重复执行。";
  copy.append(title, detail);

  const action = document.createElement("button");
  action.type = "button";
  action.className = "primary";
  action.textContent = resumeInterruptedPending ? "正在继续…" : "继续完成";
  action.disabled = resumeInterruptedPending || !activeSessionReady;
  action.addEventListener("click", () => {
    resumeInterruptedPending = true;
    renderAppTranscript({ follow: false });
    if (!send({ type: "resume-interrupted" })) {
      resumeInterruptedPending = false;
      renderAppTranscript({ follow: false });
      setUploadStatus("连接恢复中，请稍后再继续。", { clear: true });
    }
  });

  notice.append(copy, action);
  return notice;
}

function createAppProcessGroup(items) {
  const group = document.createElement("details");
  group.className = "app-process-group";
  const turnId = items[0]?.turnId || "";
  const groupId = `${turnId || "turn"}:${items[0]?.id || "process"}`;
  const activeItem = [...items].reverse().find(isRunningTranscriptItem);
  const hasFinalAnswer = appTurnHasFinalAnswer(turnId);
  const isInterruptedTurn = !hasFinalAnswer && appTurnIsInterrupted(turnId);
  const isStoppedTurn = !hasFinalAnswer && appTurnWasStopped(turnId);
  const isActiveTurn = latestTurnState.active && latestTurnState.turnId === turnId;
  const isActive = !isInterruptedTurn && !isStoppedTurn && !hasFinalAnswer && (Boolean(activeItem) || isActiveTurn);
  const autoExpanded = isActive && !openAppProcessGroups.has(groupId);
  group.open = autoExpanded || openAppProcessGroups.has(groupId);
  group.addEventListener("toggle", () => {
    if (autoExpanded && group.open) return;
    if (group.open) openAppProcessGroups.add(groupId);
    else openAppProcessGroups.delete(groupId);
  });
  const summary = document.createElement("summary");
  const currentItem = activeItem || items.at(-1);
  group.classList.toggle("is-active", isActive);
  group.classList.toggle("is-interrupted", isInterruptedTurn);
  group.classList.toggle("is-stopped", isStoppedTurn);

  const indicator = document.createElement("span");
  indicator.className = "app-activity-indicator";
  indicator.setAttribute("aria-hidden", "true");
  if (isActive) {
    indicator.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  } else if (isInterruptedTurn) {
    indicator.textContent = "!";
  } else if (isStoppedTurn) {
    indicator.textContent = "■";
  } else {
    indicator.textContent = "✓";
  }

  const label = document.createElement("strong");
  label.textContent = isActive ? "正在" : isInterruptedTurn ? "中断" : isStoppedTurn ? "已终止" : "完成";
  const message = document.createElement("span");
  message.className = "app-activity-message";
  message.textContent = isInterruptedTurn
    ? "未生成最终回复"
    : isStoppedTurn
      ? "已由你终止，Session 仍可继续"
      : appActivityText(currentItem);
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
    if (["assistant", "user"].includes(item.type) && globalThis.AgentMarkdown) {
      globalThis.AgentMarkdown.render(copy, item.text, appMarkdownRenderer);
    } else {
      copy.textContent = item.text;
    }
    card.append(copy);
  }
  if (item.attachments?.length) card.append(createAppTranscriptAttachments(item.attachments));

  if (item.detail) {
    card.append(createTranscriptDetails("查看详情", item.detail, item.type === "notice"));
  }
  if (item.output) {
    const lines = item.output.split("\n").length;
    card.append(createTranscriptDetails(`查看输出 · ${lines} 行`, item.output, false));
  }
  if (item.memoryCitation) {
    const labels = memoryCitationDocumentLabels(item.memoryCitation);
    const summary = labels.length
      ? `读取了 ${labels.length} 个上下文文档 · ${labels.join("、")}`
      : `关联了 ${item.memoryCitation.threadIds.length} 个记忆 Session`;
    card.append(createTranscriptDetails(summary, formatMemoryCitation(item.memoryCitation), false, "memory-citation"));
  }
  return card;
}

function createAppTranscriptAttachments(attachments) {
  const list = document.createElement("div");
  list.className = "app-transcript-attachments";
  for (const attachment of attachments) {
    const link = document.createElement("a");
    link.className = "app-transcript-attachment";
    link.href = `/open/local?path=${encodeURIComponent(attachment.path)}`;
    link.target = "_blank";
    link.rel = "noopener";

    if (attachment.mime.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = link.href;
      image.alt = "";
      link.append(image);
    } else {
      const type = document.createElement("span");
      type.className = "app-transcript-attachment-type";
      type.textContent = transcriptAttachmentExtension(attachment.originalName);
      link.append(type);
    }

    const copy = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = attachment.originalName;
    name.title = attachment.originalName;
    copy.append(name);
    if (attachment.size !== null) {
      const size = document.createElement("small");
      size.textContent = transcriptAttachmentSize(attachment.size);
      copy.append(size);
    }
    link.append(copy);
    list.append(link);
  }
  return list;
}

function transcriptAttachmentExtension(name) {
  const match = String(name || "").match(/\.([^.]+)$/);
  return (match?.[1] || "FILE").slice(0, 5).toUpperCase();
}

function transcriptAttachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 100 || unitIndex === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function createTranscriptDetails(summaryText, content, open = false, className = "") {
  const details = document.createElement("details");
  details.className = "app-transcript-details";
  if (className) details.classList.add(className);
  details.open = open;
  const summary = document.createElement("summary");
  summary.textContent = summaryText;
  const pre = document.createElement("pre");
  pre.textContent = content;
  details.append(summary, pre);
  return details;
}

function formatMemoryCitation(citation) {
  const entries = citation.entries.map((entry, index) => {
    const lineRange = entry.lineStart
      ? `:${entry.lineStart}${entry.lineEnd && entry.lineEnd !== entry.lineStart ? `-${entry.lineEnd}` : ""}`
      : "";
    return [`${index + 1}. ${entry.note || "记忆来源"}`, entry.path ? `   ${entry.path}${lineRange}` : ""]
      .filter(Boolean)
      .join("\n");
  });
  if (citation.threadIds.length) entries.push(`关联 Session：\n${citation.threadIds.join("\n")}`);
  return entries.join("\n\n");
}

function memoryCitationDocumentLabels(citation) {
  return [...new Set(citation.entries.map((entry) => {
    const normalized = String(entry.path || "").replaceAll("\\", "/");
    const memoryMarker = "/System/Memory/";
    if (normalized.includes(memoryMarker)) return normalized.split(memoryMarker)[1] || "个人记忆";
    const projectRule = normalized.match(/\/([^/]+\/AGENTS\.md)$/);
    if (projectRule) return projectRule[1];
    return normalized.split("/").at(-1) || "个人记忆";
  }).filter(Boolean))];
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
