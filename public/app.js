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
const sendPromptButton = document.querySelector("#send-prompt");
const promptInput = document.querySelector("#prompt");
const terminalView = document.querySelector(".terminal-view");
const textView = document.querySelector("#text-view");
const terminalText = document.querySelector("#terminal-text");

const statusEls = {
  connection: document.querySelector("#connection"),
  project: document.querySelector("#session-project"),
};

let terminal = null;
let fitAddon = null;
let terminalTouchY = null;

let socket = null;
let sessionsTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let activeSessionId = "";
let currentSessionExited = false;

window.addEventListener("resize", () => {
  fitTerminal();
  sendResize();
});

logoutButton.addEventListener("click", logout);
connectButton.addEventListener("click", () => startSession());
refreshSessionsButton.addEventListener("click", refreshLists);
backButton.addEventListener("click", showStartScreen);
disconnectButton.addEventListener("click", detach);
terminalTabButton.addEventListener("click", closeTextView);
textTabButton.addEventListener("click", openTextView);
pageUpButton.addEventListener("click", () => scrollTerminalPage(-1));
pageDownButton.addEventListener("click", () => scrollTerminalPage(1));
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

bootstrap().catch(() => {
  redirectToLogin();
});

async function bootstrap() {
  const response = await fetch("/api/auth");
  const data = await response.json();
  if (data.authenticated) {
    showStartScreen();
    await loadProjects();
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
  await Promise.all([loadLiveSessions(), loadSavedCodexSessions(), loadArchivedCodexSessions()]);
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
  sessionsList.innerHTML = "";
  if (!sessions.length) {
    sessionsList.append(empty("No live sessions. Detached sessions stay available for about one hour."));
    return;
  }

  for (const session of sessions) {
    sessionsList.append(
      sessionCard({
        title: session.title || "New Codex session",
        subtitle: `${displayProject(session.project)} · ${formatLaunch(session)} · ${formatTime(
          session.lastActivityAt,
        )}`,
        action: "Reconnect",
        onClick: () => attachSession(session.id),
      }),
    );
  }
}

function renderSavedCodexSessions(sessions) {
  codexSessionsList.innerHTML = "";
  if (!sessions.length) {
    codexSessionsList.append(empty("No saved Codex sessions found."));
    return;
  }

  for (const session of sessions) {
    codexSessionsList.append(
      sessionCard({
        title: session.title || "Untitled session",
        subtitle: `${displayProject(session.project)} · ${formatTime(session.updatedAt)}`,
        action: "Resume",
        onClick: () => startSession({ sessionId: session.id, cwd: projectForSession(session) }),
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

function openSocket(params, options = {}) {
  closeSocket();
  ensureTerminal();
  terminal?.clear();
  activeSessionId = params.attach || "";
  currentSessionExited = false;
  setConnectedState(options.reconnect ? "reconnecting" : "connecting");
  showSessionScreen();

  const query = new URLSearchParams(params);
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${window.location.host}/terminal?${query.toString()}`);

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConnectedState("connected");
    fitTerminal();
    sendResize();
  });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "output") {
      writeTerminalOutput(message.payload.raw);
      return;
    }
    if (message.type === "replay") {
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

function sendResize() {
  if (!terminal || !terminal.cols || !terminal.rows) return;
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
}

function renderStatus(status) {
  activeSessionId = status.id || activeSessionId;
  currentSessionExited = Boolean(status.exited);
  statusEls.project.textContent = status.title || displayProject(status.project);
  statusEls.connection.textContent = status.exited ? "exited" : "connected";
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

function fitTerminal() {
  if (!terminal || !fitAddon) return;
  requestAnimationFrame(() => {
    fitAddon.fit();
    sendResize();
  });
}

function scrollTerminalPage(direction) {
  if (!terminal) return;
  terminal.scrollPages(direction);
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
