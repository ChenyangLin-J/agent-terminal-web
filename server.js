import { createRequire } from "node:module";
import { execFile, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import busboy from "busboy";
import express from "express";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, ".."));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3030);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 60 * 60 * 1000);
const AUTH_VERIFY_URL = process.env.PRIVATE_AUTH_VERIFY_URL || "http://127.0.0.1:3060/api/verify";
const AUTH_LOGIN_URL = process.env.PRIVATE_AUTH_LOGIN_URL || "https://auth.chenyanglin.com/login";
const AUTH_LOGOUT_URL = process.env.PRIVATE_AUTH_LOGOUT_URL || "https://auth.chenyanglin.com/logout";
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME, "sessions");
const CODEX_ARCHIVED_SESSIONS_ROOT = path.join(CODEX_HOME, "archived_sessions");
const CODEX_SESSION_TITLES_FILE = path.join(CODEX_HOME, "session-titles.json");
const CODEX_SESSION_ARCHIVE_FILE = path.join(CODEX_HOME, "session-archive.json");
const AGENT_WEB_SESSIONS_FILE = path.join(CODEX_HOME, "agent-web-sessions.json");
const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_ROOT || path.join(WORKSPACE_ROOT, "uploads"));
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 5);
const MAX_UPLOAD_FILE_BYTES = Number(process.env.MAX_UPLOAD_FILE_BYTES || 50 * 1024 * 1024);
const MAX_RAW_BUFFER = 1024 * 1024;
const MAX_FULL_REPLAY_BYTES = 256 * 1024;
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 25_000);
const USE_TMUX_SESSIONS = process.env.AGENT_USE_TMUX === "1";
const CODEX_NOTIFY_SCRIPT = path.join(__dirname, "scripts", "codex-notify.js");
const AGENT_NOTIFY_URL = process.env.AGENT_NOTIFY_URL || `http://${HOST}:${PORT}/internal/codex-notify`;
const HOME_PUSH_URL = process.env.HOME_PUSH_URL || "http://127.0.0.1:3050/internal/push";
const HOME_PUSH_SUBSCRIBE_URL = process.env.HOME_PUSH_SUBSCRIBE_URL || `${HOME_PUSH_URL}/subscriptions`;
const HOME_VAPID_PUBLIC_KEY = process.env.HOME_VAPID_PUBLIC_KEY || "";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/terminal" });
const sessions = new Map();

wss.on("error", (error) => {
  logAgentEvent("ws-server-error", {
    code: cleanClientLogValue(error.code, 80),
    message: cleanClientLogValue(error.message, 300),
  });
});

app.use(express.json());
app.use("/shared", express.static(path.join(WORKSPACE_ROOT, "shared-web")));
app.use("/", express.static(path.join(__dirname, "public")));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "lib")));
app.use("/vendor/xterm-css", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "css")));
app.use(
  "/vendor/xterm-fit",
  express.static(path.join(__dirname, "node_modules", "@xterm", "addon-fit", "lib")),
);

app.post("/internal/codex-notify", async (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }

  const webSessionId = String(req.body?.webSessionId || "");
  const event = req.body?.event;
  if (!isValidWebSessionId(webSessionId) || event?.type !== "agent-turn-complete") {
    res.status(400).json({ error: "Invalid Codex notification." });
    return;
  }

  const session = sessions.get(webSessionId);
  if (!session || session.exited) {
    res.status(202).json({ ok: true, skipped: "session-not-running" });
    return;
  }

  const threadId = String(event["thread-id"] || "");
  if (isValidSessionId(threadId)) session.sessionId = threadId;
  session.lastActivityAt = new Date().toISOString();
  persistRestorableWebSession(session);
  broadcast(session, "status", publicSession(session));

  try {
    const result = await sendHomeTurnNotification(session, event);
    logAgentEvent("turn-notification", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      turnId: cleanClientLogValue(event["turn-id"], 100),
      sent: result.sent,
      subscriptionCount: result.subscriptionCount,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    logAgentEvent("turn-notification-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      message: error.message,
    });
    res.status(502).json({ error: "Home push failed." });
  }
});

app.get("/internal/recent-sessions", async (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }

  try {
    res.json({ sessions: await listRecentAgentSessions() });
  } catch (error) {
    console.error(`Failed to list recent Agent sessions: ${error.message}`);
    res.status(500).json({ error: "Recent Agent sessions are unavailable." });
  }
});

app.get("/api/auth", async (req, res) => {
  res.json({
    authenticated: await isAuthenticated(req),
    loginUrl: loginUrlForNext(req, getOrigin(req)),
    logoutUrl: logoutUrl(req),
  });
});

app.post("/api/login", (req, res) => {
  res.status(410).json({ loginUrl: loginUrlForNext(req, getOrigin(req)) });
});

app.post("/api/logout", (req, res) => {
  res.json({ authenticated: false, logoutUrl: logoutUrl(req) });
});

app.get("/login", (req, res) => {
  res.redirect(loginUrlForNext(req, getLoginNext(req)));
});

app.get("/logout", (req, res) => {
  res.redirect(logoutUrl(req));
});

app.use("/api", requireAuth);

app.get("/api/projects", async (_req, res) => {
  const entries = await fs.readdir(WORKSPACE_ROOT, { withFileTypes: true });
  const projects = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "uploads")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    workspaceRoot: WORKSPACE_ROOT,
    projects,
  });
});

app.get("/api/push/config", (_req, res) => {
  res.json({ configured: Boolean(HOME_VAPID_PUBLIC_KEY), publicKey: HOME_VAPID_PUBLIC_KEY });
});

app.post("/api/push/subscribe", async (req, res) => {
  const deviceId = cleanWebClientId(req.body?.deviceId);
  if (!deviceId) {
    res.status(400).json({ error: "A browser device ID is required." });
    return;
  }

  try {
    const result = await registerAgentPushSubscription(req.body?.subscription, deviceId);
    res.json({ ok: true, ...result });
  } catch (error) {
    logAgentEvent("push-subscribe-failed", { deviceId: shortClientId(deviceId), message: error.message });
    res.status(502).json({ error: "Browser notification registration failed." });
  }
});

app.post("/api/uploads", handleUpload);

app.post("/api/client-events", (req, res) => {
  const event = cleanClientEventName(req.body?.event);
  if (event) {
    logAgentEvent("client-event", {
      clientEvent: event,
      webSessionId: cleanClientLogValue(req.body?.webSessionId, 100),
      visibilityState: cleanClientLogValue(req.body?.visibilityState, 30),
      socketState: cleanClientLogValue(req.body?.socketState, 30),
      closeCode: Number.isFinite(Number(req.body?.closeCode)) ? Number(req.body.closeCode) : undefined,
      wasClean: typeof req.body?.wasClean === "boolean" ? req.body.wasClean : undefined,
      online: typeof req.body?.online === "boolean" ? req.body.online : undefined,
      path: cleanClientLogValue(req.body?.path, 300),
      replayMode: cleanClientLogValue(req.body?.replayMode, 20),
      rawChars: optionalNonNegativeInteger(req.body?.rawChars),
      outputRevision: optionalNonNegativeInteger(req.body?.outputRevision),
      expectedRevision: optionalNonNegativeInteger(req.body?.expectedRevision),
      receivedRevision: optionalNonNegativeInteger(req.body?.receivedRevision),
      durationMs: optionalNonNegativeInteger(req.body?.durationMs),
    });
  }
  res.json({ ok: true });
});

app.get("/api/sessions", (_req, res) => {
  const liveSessions = [...sessions.values()].filter((session) => !session.exited).map(publicSession);
  const restoredSessions = listDetachedTmuxSessions().filter(
    (session) => !sessions.has(session.id) && !liveSessions.some((liveSession) => liveSession.id === session.id),
  );

  res.json({
    ttlMs: SESSION_TTL_MS,
    sessions: [...liveSessions, ...restoredSessions],
  });
});

app.get("/api/codex-sessions", async (_req, res) => {
  const codexSessions = await listCodexSessions({ archived: false });
  res.json({ sessions: codexSessions });
});

app.get("/api/codex-sessions/archived", async (_req, res) => {
  const codexSessions = await listCodexSessions({ archived: true });
  res.json({ sessions: codexSessions });
});

app.put("/api/codex-sessions/:id/title", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const title = cleanCustomTitle(req.body?.title);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    const titles = await readSessionTitles();
    if (title) {
      titles[id] = title;
    } else {
      delete titles[id];
    }
    await writeSessionTitles(titles);
    for (const session of sessions.values()) {
      if (session.sessionId === id && title) {
        session.title = title;
        persistRestorableWebSession(session);
      }
    }
    res.json({ id, customTitle: title });
  } catch (error) {
    res.status(500).json({ error: `Failed to save title: ${error.message}` });
  }
});

app.put("/api/codex-sessions/:id/archive", async (req, res) => {
  const id = String(req.params.id || "").trim();
  const archived = Boolean(req.body?.archived);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    await setSessionArchived(id, archived);
    res.json({ id, archived });
  } catch (error) {
    res.status(500).json({ error: `Failed to update archive: ${error.message}` });
  }
});

app.get("/api/git-status", async (req, res) => {
  const cwd = resolveWorkspacePath(String(req.query.cwd || "."));
  if (!cwd) {
    res.status(400).json({ error: "cwd must stay inside the workspace root" });
    return;
  }

  try {
    const output = await execFileText("git", ["status", "--short", "--branch"], cwd);
    res.json({ cwd, git: output.trim() || "clean" });
  } catch {
    res.json({ cwd, git: "not a git repository" });
  }
});

wss.on("connection", async (ws, req) => {
  registerWebSocketErrorHandler(ws, req);

  if (!(await isAuthenticated(req))) {
    logAgentEvent("ws-reject", { reason: "not-authenticated" });
    send(ws, "error", { message: "Not authenticated." });
    ws.close();
    return;
  }

  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const attachId = String(url.searchParams.get("attach") || "").trim();
  const shouldReplay = url.searchParams.get("replay") !== "0";
  const afterRevision = parseOutputRevision(url.searchParams.get("afterRevision"));
  const clientId = cleanWebClientId(url.searchParams.get("clientId"));

  let session = attachId ? sessions.get(attachId) : null;
  if (!session && attachId) {
    const restored = restoreTmuxSession(attachId);
    if (restored?.error) {
      logAgentEvent("session-restore-failed", { webSessionId: attachId, reason: restored.error });
      send(ws, "error", { message: restored.error, goHome: true });
      ws.close();
      return;
    }

    if (restored) {
      session = restored;
      logAgentEvent("session-restore", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        tmuxName: session.tmuxName,
      });
    } else if (url.searchParams.get("sessionId")) {
      logAgentEvent("session-attach-missing-fallback", {
        webSessionId: attachId,
        codexSessionId: url.searchParams.get("sessionId"),
      });
    } else {
      logAgentEvent("session-attach-missing", { webSessionId: attachId });
      send(ws, "error", { message: "This web session is no longer running. Returning to Agent home.", goHome: true });
      ws.close();
      return;
    }
  }

  if (!session) {
    const cwd = resolveWorkspacePath(url.searchParams.get("cwd") || ".");
    const launch = getLaunchConfig(url.searchParams);

    if (!cwd) {
      logAgentEvent("ws-reject", { reason: "invalid-cwd" });
      send(ws, "error", { message: "Invalid cwd outside workspace root." });
      ws.close();
      return;
    }

    if (!launch) {
      logAgentEvent("ws-reject", { reason: "invalid-launch" });
      send(ws, "error", { message: "Invalid launch mode or session ID." });
      ws.close();
      return;
    }

    session = findReusableSession(launch);
    if (session) {
      logAgentEvent("session-reuse", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        clients: session.clients.size,
      });
    }

    if (session) {
      attachClient(session, ws, { replay: shouldReplay, afterRevision, clientId });
      return;
    }

    launch.title = await titleForLaunch(launch);
    session = createSession(cwd, launch);
    if (session.error) {
      logAgentEvent("session-start-failed", { reason: session.error });
      send(ws, "error", { message: session.error });
      ws.close();
      return;
    }
  } else {
    logAgentEvent("session-reconnect", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      clients: session.clients.size,
    });
  }

  attachClient(session, ws, { replay: shouldReplay, afterRevision, clientId });
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Terminal Web: http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log(`Detached session TTL: ${Math.round(SESSION_TTL_MS / 60000)} minutes`);
});

function isDirectLoopbackRequest(req) {
  const address = req.socket.remoteAddress || "";
  const isLoopback = address === "127.0.0.1" || address === "::1" || address.startsWith("::ffff:127.");
  return isLoopback && !req.headers["x-forwarded-for"] && !req.headers["x-forwarded-host"];
}

async function sendHomeTurnNotification(session, event) {
  if (!session.notificationDeviceId) {
    return { sent: 0, subscriptionCount: 0, skipped: "no-browser-device" };
  }

  const notificationApp = session.notificationApp === "home" ? "home" : "agent";
  const title = cleanCustomTitle(session.title) || "Codex session";
  const query = new URLSearchParams({
    attach: session.id,
    cwd: session.project || ".",
    title,
  });
  if (session.sessionId) query.set("sessionId", session.sessionId);

  const response = await fetch(HOME_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      notification: {
        title: `Agent 完成 · ${title}`,
        body: "任务已完成，点开查看结果。",
        url: notificationApp === "home" ? `/open/agent?${query}` : `/?${query}`,
        tag: `agent-${session.sessionId || session.id}`,
        badge: 0,
      },
      target: { app: notificationApp, deviceId: session.notificationDeviceId },
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Home push returned ${response.status}: ${detail}`);
  }
  return response.json();
}

async function registerAgentPushSubscription(subscription, deviceId) {
  const response = await fetch(HOME_PUSH_SUBSCRIBE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app: "agent", deviceId, subscription }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`Home push registration returned ${response.status}: ${detail}`);
  }
  return response.json();
}

async function requireAuth(req, res, next) {
  if (await isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated." });
}

async function isAuthenticated(req) {
  try {
    const response = await fetch(AUTH_VERIFY_URL, {
      headers: {
        cookie: req.headers.cookie || "",
      },
    });
    if (!response.ok) return false;

    const data = await response.json();
    return Boolean(data.authenticated);
  } catch (error) {
    console.error(`Auth verify failed: ${error.message}`);
    return false;
  }
}

function loginUrlForNext(req, next) {
  return `${AUTH_LOGIN_URL}?next=${encodeURIComponent(next || getOrigin(req))}`;
}

function logoutUrl(req) {
  return `${AUTH_LOGOUT_URL}?next=${encodeURIComponent(getOrigin(req))}`;
}

function getOrigin(req) {
  const protocol = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || "agent.chenyanglin.com";
  return `${protocol}://${host}`;
}

function getLoginNext(req) {
  const next = String(req.query?.next || "");
  if (next.startsWith("/") && !next.startsWith("//")) return `${getOrigin(req)}${next}`;

  try {
    const url = new URL(next);
    if (url.hostname === "chenyanglin.com" || url.hostname.endsWith(".chenyanglin.com")) {
      return url.toString();
    }
  } catch {
    return getOrigin(req);
  }

  return getOrigin(req);
}

function logAgentEvent(event, fields = {}) {
  console.log(
    JSON.stringify({
      scope: "agent-terminal-web",
      event,
      at: new Date().toISOString(),
      ...fields,
    }),
  );
}

function cleanClientEventName(value) {
  const event = String(value || "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "-")
    .slice(0, 80);
  return event || "";
}

function codexArgsForWeb(args) {
  const notify = JSON.stringify([process.execPath, CODEX_NOTIFY_SCRIPT]);
  return ["-c", `notify=${notify}`, ...args];
}

function cleanClientLogValue(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, maxLength);
}

function cleanWebClientId(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, 80);
}

function shortClientId(value) {
  return String(value || "").slice(0, 12);
}

function createSession(cwd, launch, restored = {}) {
  const id = restored.id || cryptoRandomId();
  const startedAt = new Date().toISOString();
  const shell = process.env.CODEX_COMMAND || "codex";
  const commandArgs = codexArgsForWeb(launch.args);
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    AGENT_WEB_SESSION_ID: id,
    AGENT_NOTIFY_URL,
  };
  const tmuxName = restored.tmuxName || tmuxNameForWebSession(id);

  let terminal;
  try {
    if (USE_TMUX_SESSIONS && restored.attachExistingTmux) {
      if (!tmuxHasSession(tmuxName)) return { error: "This web session is no longer running. Returning to Agent home." };
    } else if (USE_TMUX_SESSIONS) {
      ensureTmuxSession(tmuxName, cwd, [shell, ...commandArgs], env);
    }
    terminal = USE_TMUX_SESSIONS
      ? pty.spawn("tmux", ["attach-session", "-t", tmuxName], {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd,
          env,
        })
      : pty.spawn(shell, commandArgs, {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          cwd,
          env,
        });
  } catch (error) {
    return { error: `Failed to start or attach codex: ${error.message}` };
  }

  const session = {
    id,
    cwd,
    project: path.relative(WORKSPACE_ROOT, cwd) || ".",
    pid: terminal.pid,
    command: shell,
    args: commandArgs,
    mode: launch.mode,
    sessionId: launch.sessionId,
    title: launch.title || "",
    tmuxName,
    terminal,
    clients: new Set(),
    cleanupTimer: null,
    exited: false,
    exitCode: null,
    signal: null,
    notificationApp: restored.notificationApp === "home" ? "home" : "agent",
    notificationDeviceId: cleanWebClientId(restored.notificationDeviceId),
    outputRevision: 0,
    outputChunks: [],
    outputChunkBytes: 0,
    startedAt: restored.startedAt || startedAt,
    lastActivityAt: restored.lastActivityAt || restored.startedAt || startedAt,
    cols: 100,
    rows: 30,
  };
  sessions.set(id, session);
  persistRestorableWebSession(session);
  logAgentEvent("session-start", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    mode: session.mode,
    project: session.project,
    pid: session.pid,
    tmuxName: USE_TMUX_SESSIONS ? session.tmuxName : "",
    restored: Boolean(restored.attachExistingTmux),
  });

  terminal.onData((data) => {
    session.lastActivityAt = new Date().toISOString();
    const revision = appendBuffers(session, data);
    broadcast(session, "output", { raw: data, revision });
    broadcast(session, "status", publicSession(session));
  });

  terminal.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.signal = signal;
    if (USE_TMUX_SESSIONS && !tmuxHasSession(session.tmuxName)) removePersistedWebSession(session.id);
    logAgentEvent("terminal-exit", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      exitCode,
      signal,
    });
    broadcast(session, "status", publicSession(session));
    for (const client of session.clients) client.close();
    scheduleCleanup(session);
  });

  return session;
}

function findReusableSession(launch) {
  if (!launch.sessionId) return null;

  return (
    [...sessions.values()]
      .filter((session) => !session.exited && session.sessionId === launch.sessionId)
      .sort((a, b) => {
        if (b.clients.size !== a.clients.size) return b.clients.size - a.clients.size;
        return new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime();
      })[0] || null
  );
}

function restoreTmuxSession(id) {
  if (!isValidWebSessionId(id)) return { error: "Invalid web session id. Returning to Agent home." };

  const record = readPersistedWebSessions()[id];
  if (!record) return null;

  const cwd = persistedWorkspacePath(record.cwd);
  if (!cwd) {
    removePersistedWebSession(id);
    return { error: "This web session has an invalid directory. Returning to Agent home." };
  }

  if (!USE_TMUX_SESSIONS) {
    if (!record.sessionId) return null;
    const reusable = findReusableSession({ sessionId: record.sessionId });
    if (reusable) return reusable;

    return createSession(
      cwd,
      {
        mode: "resume-id",
        sessionId: record.sessionId,
        args: ["--no-alt-screen", "resume", record.sessionId],
        title: record.title || "",
      },
      {
        id,
        startedAt: record.startedAt,
        lastActivityAt: record.lastActivityAt,
        notificationApp: record.notificationApp,
        notificationDeviceId: record.notificationDeviceId,
      },
    );
  }

  const tmuxName = cleanTmuxName(record.tmuxName || tmuxNameForWebSession(id));
  if (!tmuxName || !tmuxHasSession(tmuxName)) {
    removePersistedWebSession(id);
    return { error: "This web session is no longer running. Returning to Agent home." };
  }

  const launch = {
    mode: record.mode || "new",
    sessionId: record.sessionId || "",
    args: Array.isArray(record.args) && record.args.length ? record.args : ["--no-alt-screen"],
    title: record.title || "",
  };

  return createSession(cwd, launch, {
    id,
    tmuxName,
    attachExistingTmux: true,
    startedAt: record.startedAt,
    lastActivityAt: record.lastActivityAt,
    notificationApp: record.notificationApp,
    notificationDeviceId: record.notificationDeviceId,
  });
}

function listDetachedTmuxSessions() {
  if (!USE_TMUX_SESSIONS) return [];
  const records = readPersistedWebSessions();
  const items = [];

  for (const [id, record] of Object.entries(records)) {
    if (sessions.has(id) || !isValidWebSessionId(id)) continue;
    const tmuxName = cleanTmuxName(record.tmuxName || tmuxNameForWebSession(id));
    if (!tmuxName || !tmuxHasSession(tmuxName)) continue;

    const cwd = persistedWorkspacePath(record.cwd);
    if (!cwd) continue;

    items.push({
      id,
      cwd,
      project: path.relative(WORKSPACE_ROOT, cwd) || ".",
      title: record.title || "New Codex session",
      pid: null,
      command: record.command || "codex",
      args: Array.isArray(record.args) ? record.args : [],
      mode: record.mode || "new",
      sessionId: record.sessionId || "",
      startedAt: record.startedAt || new Date().toISOString(),
      lastActivityAt: record.lastActivityAt || record.startedAt || new Date().toISOString(),
      cols: 100,
      rows: 30,
      connectedClients: 0,
      detachedExpiresAt: null,
      exited: false,
      exitCode: null,
      signal: null,
    });
  }

  return items;
}

function attachClient(session, ws, { replay = true, afterRevision = null, clientId = "" } = {}) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  ws.webSessionId = session.id;
  ws.codexSessionId = session.sessionId;
  const heartbeatTimer = startWebSocketHeartbeat(ws, session);
  ws.clientId = clientId;
  closeDuplicateClient(session, ws);
  session.clients.add(ws);
  logAgentEvent("ws-attach", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    clients: session.clients.size,
    clientId: clientId ? shortClientId(clientId) : "",
  });
  send(ws, "status", publicSession(session));
  if (replay) {
    const replayPayload = outputReplay(session, afterRevision);
    logAgentEvent("ws-replay", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      replayMode: replayPayload.mode,
      afterRevision,
      outputRevision: replayPayload.revision,
      rawBytes: Buffer.byteLength(replayPayload.raw, "utf8"),
    });
    send(ws, "replay", replayPayload);
  } else if (!replay) {
    logAgentEvent("ws-replay-skip", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
    });
  }

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.type === "client-ping") {
      send(ws, "client-pong", { sentAt: message.sentAt || null, receivedAt: Date.now() });
      return;
    }

    if (session.exited) return;

    if (message.type === "input" && typeof message.data === "string") {
      rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
      logControlMessage(session, ws, "input", message.data);
      session.terminal.write(message.data);
      session.lastActivityAt = new Date().toISOString();
      send(ws, "control-ack", { kind: "input", receivedAt: Date.now() });
      return;
    }

    if (message.type === "submit" && typeof message.data === "string") {
      const normalized = message.data.trim();
      if (normalized) {
        rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
        logControlMessage(session, ws, "submit", normalized);
        if (!session.title) session.title = cleanTitle(normalized) || "New Codex session";
        writeAndSubmit(session, normalized, { paste: true });
        session.lastActivityAt = new Date().toISOString();
        persistRestorableWebSession(session);
        broadcast(session, "status", publicSession(session));
        send(ws, "control-ack", { kind: "submit", receivedAt: Date.now() });
      }
      return;
    }

    if (message.type === "command" && typeof message.data === "string") {
      rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
      logControlMessage(session, ws, "command", message.data);
      writeAndSubmit(session, message.data.trim(), { paste: false });
      session.lastActivityAt = new Date().toISOString();
      persistRestorableWebSession(session);
      send(ws, "control-ack", { kind: "command", receivedAt: Date.now() });
      return;
    }

    if (message.type === "resize") {
      const cols = clampInteger(message.cols, 20, 240, 100);
      const rows = clampInteger(message.rows, 8, 80, 30);
      session.terminal.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
      broadcast(session, "status", publicSession(session));
      return;
    }

    if (message.type === "kill") {
      logAgentEvent("terminal-kill", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        reason: "client-request",
      });
      killSessionTerminal(session);
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(heartbeatTimer);
    session.clients.delete(ws);
    logAgentEvent("ws-close", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      code,
      reason: reason?.toString() || "",
      clients: session.clients.size,
      exited: session.exited,
    });
    if (session.clients.size === 0) scheduleCleanup(session);
  });
}

function registerWebSocketErrorHandler(ws, req) {
  ws.on("error", (error) => {
    logAgentEvent("ws-error", {
      webSessionId: ws.webSessionId || "",
      codexSessionId: ws.codexSessionId || "",
      code: cleanClientLogValue(error.code, 80),
      message: cleanClientLogValue(error.message, 300),
      remoteAddress: cleanClientLogValue(req.socket.remoteAddress, 80),
    });
  });
}

function rememberNotificationTarget(session, app, value) {
  const deviceId = cleanWebClientId(value);
  if (!deviceId) return;
  session.notificationApp = app === "home" ? "home" : "agent";
  session.notificationDeviceId = deviceId;
}

function startWebSocketHeartbeat(ws, session) {
  return setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;

    try {
      ws.ping();
    } catch (error) {
      logAgentEvent("ws-heartbeat-failed", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        message: error.message,
      });
    }
  }, WS_HEARTBEAT_MS);
}

function closeDuplicateClient(session, ws) {
  if (!ws.clientId) return;

  for (const client of session.clients) {
    if (client !== ws && client.clientId === ws.clientId) {
      logAgentEvent("ws-close-duplicate-client", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        clientId: shortClientId(ws.clientId),
      });
      session.clients.delete(client);
      client.terminate();
    }
  }
}

function logControlMessage(session, ws, kind, data) {
  logAgentEvent("client-control", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    clientId: ws.clientId ? shortClientId(ws.clientId) : "",
    kind,
    dataBytes: Buffer.byteLength(String(data || ""), "utf8"),
    clients: session.clients.size,
  });
}

function scheduleCleanup(session) {
  if (session.cleanupTimer) return;
  logAgentEvent("cleanup-scheduled", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    ttlMs: SESSION_TTL_MS,
  });
  session.cleanupTimer = setTimeout(() => {
    if (!session.exited) {
      logAgentEvent("terminal-kill", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        reason: "detached-ttl",
      });
      killSessionTerminal(session);
    }
    sessions.delete(session.id);
    removePersistedWebSession(session.id);
    logAgentEvent("session-cleanup", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
    });
  }, SESSION_TTL_MS);
}

async function handleUpload(req, res) {
  if (!String(req.headers["content-type"] || "").includes("multipart/form-data")) {
    res.status(400).json({ error: "Expected multipart form upload." });
    return;
  }

  const uploadDir = path.join(UPLOADS_ROOT, dateDirectoryName(new Date()));
  await fs.mkdir(uploadDir, { recursive: true, mode: 0o700 });

  const savedFiles = [];
  const pendingWrites = [];
  let fileCount = 0;
  let rejected = "";
  let responded = false;

  const form = busboy({
    headers: req.headers,
    defParamCharset: "utf8",
    limits: {
      files: MAX_UPLOAD_FILES,
      fileSize: MAX_UPLOAD_FILE_BYTES,
    },
  });

  const fail = async (status, message) => {
    if (responded) return;
    responded = true;
    await cleanupUploadedFiles(savedFiles);
    res.status(status).json({ error: message });
  };

  form.on("file", (_fieldName, file, info) => {
    fileCount += 1;
    if (fileCount > MAX_UPLOAD_FILES) {
      rejected = `Upload at most ${MAX_UPLOAD_FILES} files at a time.`;
      file.resume();
      return;
    }

    const originalName = cleanUploadOriginalName(info.filename);
    let reservedFile;
    try {
      reservedFile = reserveUploadFile(uploadDir, originalName);
    } catch (error) {
      rejected = `Could not save ${originalName}: ${error.message}`;
      file.resume();
      return;
    }

    const { storedName, filePath, output } = reservedFile;
    let size = 0;
    let hitSizeLimit = false;

    file.on("data", (chunk) => {
      size += chunk.length;
    });

    file.on("limit", () => {
      hitSizeLimit = true;
      rejected = `Each file must be ${formatBytes(MAX_UPLOAD_FILE_BYTES)} or smaller.`;
    });

    const write = finished(output)
      .then(async () => {
        if (hitSizeLimit || file.truncated) {
          await fs.rm(filePath, { force: true });
          throw new Error(`Each file must be ${formatBytes(MAX_UPLOAD_FILE_BYTES)} or smaller.`);
        }
        const saved = {
          path: filePath,
          originalName,
          storedName,
          size,
          mime: info.mimeType || "application/octet-stream",
        };
        savedFiles.push(saved);
      })
      .catch(async (error) => {
        await fs.rm(filePath, { force: true });
        throw error;
      });

    pendingWrites.push(write);
    file.pipe(output);
  });

  form.on("filesLimit", () => {
    rejected = `Upload at most ${MAX_UPLOAD_FILES} files at a time.`;
  });

  form.on("error", (error) => {
    fail(400, `Upload failed: ${error.message}`);
  });

  form.on("finish", async () => {
    if (responded) return;

    try {
      await Promise.all(pendingWrites);
      if (rejected) {
        await fail(400, rejected);
        return;
      }
      if (!savedFiles.length) {
        await fail(400, "No files uploaded.");
        return;
      }
      responded = true;
      res.json({ files: savedFiles });
    } catch (error) {
      await fail(400, `Upload failed: ${error.message}`);
    }
  });

  req.pipe(form);
}

function writeAndSubmit(session, text, { paste }) {
  if (!text) return;
  session.terminal.write("\x15");
  setTimeout(() => {
    if (paste) {
      session.terminal.write(`\x1b[200~${text}\x1b[201~`);
    } else {
      session.terminal.write(text);
    }
    setTimeout(() => session.terminal.write("\r"), 30);
  }, 20);
}

function appendBuffers(session, raw) {
  const revision = session.outputRevision + 1;
  const bytes = Buffer.byteLength(raw, "utf8");
  session.outputRevision = revision;
  session.outputChunks.push({ revision, raw, bytes });
  session.outputChunkBytes += bytes;
  while (session.outputChunkBytes > MAX_RAW_BUFFER && session.outputChunks.length > 1) {
    session.outputChunkBytes -= session.outputChunks.shift().bytes;
  }
  return revision;
}

function outputReplay(session, afterRevision) {
  const revision = session.outputRevision;
  const chunks = session.outputChunks;
  const oldestRevision = chunks[0]?.revision ?? revision + 1;
  const canSendDelta =
    afterRevision !== null && afterRevision <= revision && afterRevision >= oldestRevision - 1;

  if (canSendDelta) {
    const deltaChunks = chunks.filter((chunk) => chunk.revision > afterRevision);
    const deltaBytes = deltaChunks.reduce((total, chunk) => total + chunk.bytes, 0);
    if (deltaBytes <= MAX_FULL_REPLAY_BYTES) {
      return {
        mode: "delta",
        raw: deltaChunks.map((chunk) => chunk.raw).join(""),
        fromRevision: afterRevision,
        revision,
      };
    }
  }

  let bytes = 0;
  const recentChunks = [];
  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (recentChunks.length && bytes + chunk.bytes > MAX_FULL_REPLAY_BYTES) break;
    recentChunks.push(chunk.raw);
    bytes += chunk.bytes;
  }

  return {
    mode: "full",
    raw: recentChunks.reverse().join(""),
    fromRevision: null,
    revision,
  };
}

function publicSession(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    project: session.project,
    title: session.title || "New Codex session",
    pid: session.pid,
    command: session.command,
    args: session.args,
    mode: session.mode,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    cols: session.cols,
    rows: session.rows,
    connectedClients: session.clients.size,
    detachedExpiresAt:
      session.clients.size === 0 ? new Date(Date.now() + SESSION_TTL_MS).toISOString() : null,
    exited: session.exited,
    exitCode: session.exitCode,
    signal: session.signal,
    outputRevision: session.outputRevision,
  };
}

function ensureTmuxSession(tmuxName, cwd, commandWithArgs, env) {
  if (tmuxHasSession(tmuxName)) return;

  execFileSync("tmux", ["new-session", "-d", "-s", tmuxName, "-c", cwd, shellCommand(commandWithArgs)], {
    cwd,
    env,
    stdio: "pipe",
  });
  execFileSync("tmux", ["set-option", "-t", tmuxName, "status", "off"], { stdio: "ignore" });
  execFileSync("tmux", ["set-option", "-t", tmuxName, "remain-on-exit", "off"], { stdio: "ignore" });
  execFileSync("tmux", ["set-option", "-t", tmuxName, "history-limit", "50000"], { stdio: "ignore" });
}

function tmuxHasSession(tmuxName) {
  if (!tmuxName) return false;
  try {
    execFileSync("tmux", ["has-session", "-t", tmuxName], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function killSessionTerminal(session) {
  try {
    if (USE_TMUX_SESSIONS && session.tmuxName && tmuxHasSession(session.tmuxName)) {
      execFileSync("tmux", ["kill-session", "-t", session.tmuxName], { stdio: "ignore" });
    }
  } catch (error) {
    console.error(`Failed to kill tmux session ${session.tmuxName}: ${error.message}`);
  }
  removePersistedWebSession(session.id);
  session.terminal.kill();
}

function tmuxNameForWebSession(id) {
  return cleanTmuxName(`codex-agent-${id}`);
}

function cleanTmuxName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 80);
}

function shellCommand(commandWithArgs) {
  return commandWithArgs.map(shellQuote).join(" ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function persistRestorableWebSession(session) {
  if (USE_TMUX_SESSIONS || session.sessionId) persistWebSession(session);
}

function persistWebSession(session) {
  const records = readPersistedWebSessions();
  records[session.id] = {
    id: session.id,
    cwd: session.cwd,
    command: session.command,
    args: session.args,
    mode: session.mode,
    sessionId: session.sessionId,
    title: session.title,
    notificationApp: session.notificationApp,
    notificationDeviceId: session.notificationDeviceId,
    tmuxName: session.tmuxName,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
  };
  writePersistedWebSessions(records);
}

function removePersistedWebSession(id) {
  const records = readPersistedWebSessions();
  if (!records[id]) return;
  delete records[id];
  writePersistedWebSessions(records);
}

function readPersistedWebSessions() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(AGENT_WEB_SESSIONS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function writePersistedWebSessions(records) {
  try {
    fsSync.mkdirSync(path.dirname(AGENT_WEB_SESSIONS_FILE), { recursive: true });
    const cleaned = Object.fromEntries(
      Object.entries(records)
        .filter(([id, record]) => isValidWebSessionId(id) && record && typeof record === "object")
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const tempFile = `${AGENT_WEB_SESSIONS_FILE}.${process.pid}.tmp`;
    fsSync.writeFileSync(tempFile, `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 });
    fsSync.renameSync(tempFile, AGENT_WEB_SESSIONS_FILE);
  } catch (error) {
    console.error(`Failed to write agent web sessions: ${error.message}`);
  }
}

function isValidWebSessionId(value) {
  return /^[a-z0-9-]{8,80}$/i.test(String(value || ""));
}

function persistedWorkspacePath(value) {
  const requested = path.resolve(String(value || WORKSPACE_ROOT));
  const relative = path.relative(WORKSPACE_ROOT, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return requested;
}

function resolveWorkspacePath(value) {
  const requested = path.resolve(WORKSPACE_ROOT, value);
  const relative = path.relative(WORKSPACE_ROOT, requested);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return requested;
}

function getLaunchConfig(searchParams) {
  const sessionId = String(searchParams.get("sessionId") || "").trim();
  if (sessionId && !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) return null;

  if (sessionId) {
    return {
      mode: "resume-id",
      sessionId,
      args: ["--no-alt-screen", "resume", sessionId],
    };
  }

  const mode = String(searchParams.get("mode") || "new");
  if (mode === "new") return { mode, sessionId: "", args: ["--no-alt-screen"] };
  if (mode === "resume-picker") {
    return { mode, sessionId: "", args: ["--no-alt-screen", "resume"] };
  }
  if (mode === "resume-last") {
    return { mode, sessionId: "", args: ["--no-alt-screen", "resume", "--last"] };
  }
  return null;
}

async function titleForLaunch(launch) {
  if (launch.sessionId) {
    const meta = await readCodexSessionById(launch.sessionId);
    return meta?.title || "";
  }

  if (launch.mode === "resume-last") {
    const [latest] = await listCodexSessions({ archived: false });
    return latest?.title || "";
  }

  return "";
}

async function readCodexSessionById(id) {
  const activeFiles = (await walkFiles(CODEX_SESSIONS_ROOT)).map((file) => ({ file, fileArchived: false }));
  const archivedFiles = (await walkFiles(CODEX_ARCHIVED_SESSIONS_ROOT)).map((file) => ({
    file,
    fileArchived: true,
  }));
  const customTitles = await readSessionTitles();
  const archivedSessions = await readSessionArchive();

  for (const { file, fileArchived } of [...activeFiles, ...archivedFiles]) {
    if (!file.endsWith(".jsonl")) continue;
    if (sessionIdFromFilename(file) !== id) continue;
    return readCodexSessionMeta(file, customTitles, archivedSessions, fileArchived);
  }

  return null;
}

async function listCodexSessions({ archived }) {
  const activeFiles = (await walkFiles(CODEX_SESSIONS_ROOT)).map((file) => ({ file, fileArchived: false }));
  const archivedFiles = (await walkFiles(CODEX_ARCHIVED_SESSIONS_ROOT)).map((file) => ({
    file,
    fileArchived: true,
  }));
  const files = [...activeFiles, ...archivedFiles];
  const customTitles = await readSessionTitles();
  const archivedSessions = await readSessionArchive();
  const items = [];

  for (const { file, fileArchived } of files) {
    if (!file.endsWith(".jsonl")) continue;
    const meta = await readCodexSessionMeta(file, customTitles, archivedSessions, fileArchived);
    if (!meta) continue;
    if (Boolean(meta.archived) === archived) items.push(meta);
  }

  return items
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 40);
}

async function listRecentAgentSessions(limit = 40) {
  const savedSessions = await listCodexSessions({ archived: false });
  const liveSessions = [
    ...[...sessions.values()].filter((session) => !session.exited).map(publicSession),
    ...listDetachedTmuxSessions(),
  ];
  const liveByCodexId = new Map();

  for (const session of liveSessions) {
    if (!session.sessionId) continue;
    const current = liveByCodexId.get(session.sessionId);
    if (!current || compareRecentLiveSession(session, current) > 0) {
      liveByCodexId.set(session.sessionId, session);
    }
  }

  return savedSessions
    .map((session) => {
      const liveSession = liveByCodexId.get(session.id) || null;
      const updatedAt = latestTimestamp(session.updatedAt, liveSession?.lastActivityAt);
      const title = session.title || "Untitled session";
      const project = liveSession?.project || session.project || ".";
      return {
        id: session.id,
        title,
        project,
        updatedAt,
        live: Boolean(liveSession),
        webSessionId: liveSession?.id || "",
      };
    })
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, limit);
}

function compareRecentLiveSession(left, right) {
  const connectedClients = (left.connectedClients || 0) - (right.connectedClients || 0);
  if (connectedClients !== 0) return connectedClients;
  return new Date(left.lastActivityAt).getTime() - new Date(right.lastActivityAt).getTime();
}

function latestTimestamp(left, right) {
  const leftTime = new Date(left || 0).getTime();
  const rightTime = new Date(right || 0).getTime();
  return rightTime > leftTime ? right : left;
}

async function walkFiles(root) {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(root, entry.name);
        if (entry.isDirectory()) return walkFiles(fullPath);
        return entry.isFile() ? [fullPath] : [];
      }),
    );
    return files.flat();
  } catch {
    return [];
  }
}

async function readCodexSessionMeta(file, customTitles = {}, archivedSessions = {}, fileArchived = false) {
  const firstLine = await readFirstLine(file);
  if (!firstLine) return null;

  try {
    const parsed = JSON.parse(firstLine);
    const payload = parsed.payload || {};
    const id = payload.id || sessionIdFromFilename(file);
    const cwd = payload.cwd || "";
    const stat = await fs.stat(file);
    const title = await readCodexSessionTitle(file);
    const customTitle = customTitles[id] || "";
    const archiveRecord = archivedSessions[id] || null;
    const isArchived = fileArchived || Boolean(archiveRecord);
    return {
      id,
      title: customTitle || title,
      originalTitle: title,
      customTitle,
      archived: isArchived,
      archivedAt: archiveRecord?.archivedAt || "",
      cwd,
      project: projectFromCwd(cwd),
      source: payload.source || payload.originator || "",
      cliVersion: payload.cli_version || "",
      createdAt: payload.timestamp || parsed.timestamp || stat.birthtime.toISOString(),
      updatedAt: stat.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

async function readSessionTitles() {
  try {
    const raw = await fs.readFile(CODEX_SESSION_TITLES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, title]) => [String(id), cleanCustomTitle(title)])
        .filter(([id, title]) => isValidSessionId(id) && title),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.error(`Failed to read session titles: ${error.message}`);
    return {};
  }
}

async function writeSessionTitles(titles) {
  await fs.mkdir(path.dirname(CODEX_SESSION_TITLES_FILE), { recursive: true });
  const cleaned = Object.fromEntries(
    Object.entries(titles)
      .map(([id, title]) => [String(id), cleanCustomTitle(title)])
      .filter(([id, title]) => isValidSessionId(id) && title)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const tempFile = `${CODEX_SESSION_TITLES_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, CODEX_SESSION_TITLES_FILE);
}

async function readSessionArchive() {
  try {
    const raw = await fs.readFile(CODEX_SESSION_ARCHIVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, record]) => {
          const archivedAt =
            record && typeof record === "object" ? String(record.archivedAt || "") : String(record || "");
          return [String(id), { archivedAt }];
        })
        .filter(([id]) => isValidSessionId(id)),
    );
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.error(`Failed to read session archive: ${error.message}`);
    return {};
  }
}

async function writeSessionArchive(archive) {
  await fs.mkdir(path.dirname(CODEX_SESSION_ARCHIVE_FILE), { recursive: true });
  const cleaned = Object.fromEntries(
    Object.entries(archive)
      .map(([id, record]) => [
        String(id),
        { archivedAt: String(record?.archivedAt || new Date().toISOString()) },
      ])
      .filter(([id]) => isValidSessionId(id))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const tempFile = `${CODEX_SESSION_ARCHIVE_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, CODEX_SESSION_ARCHIVE_FILE);
}

async function setSessionArchived(id, archived) {
  const archive = await readSessionArchive();
  if (archived) {
    archive[id] = { archivedAt: new Date().toISOString() };
  } else {
    delete archive[id];
  }
  await writeSessionArchive(archive);

  try {
    await execFileText("codex", [archived ? "archive" : "unarchive", id], WORKSPACE_ROOT);
  } catch (error) {
    console.warn(`Codex ${archived ? "archive" : "unarchive"} failed for ${id}: ${error.message}`);
  }
}

function cleanCustomTitle(value) {
  return truncateTitle(
    String(value || "")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function isValidSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(String(value || ""));
}

async function readCodexSessionTitle(file) {
  const stream = fsSync.createReadStream(file, { encoding: "utf8", highWaterMark: 16_384 });
  let buffer = "";
  let linesRead = 0;

  for await (const chunk of stream) {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      linesRead += 1;
      const title = titleFromJsonLine(line);
      if (title) return title;
      if (linesRead > 300) {
        stream.destroy();
        return "";
      }
    }
  }

  return titleFromJsonLine(buffer) || "";
}

function titleFromJsonLine(line) {
  if (!line.trim()) return "";

  try {
    const parsed = JSON.parse(line);
    const payload = parsed.payload || {};

    if (parsed.type === "event_msg" && payload.type === "user_message") {
      return cleanTitle(payload.message);
    }

    if (parsed.type === "response_item" && payload.type === "message" && payload.role === "user") {
      return cleanTitle(textFromContent(payload.content));
    }
  } catch {
    return "";
  }

  return "";
}

function textFromContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.text || "")
    .filter(Boolean)
    .join("\n");
}

function cleanTitle(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.startsWith("# AGENTS.md instructions")) return "";
  if (text.startsWith("<environment_context>")) return "";
  if (text.startsWith("You are Codex,")) return "";
  if (text.length > 500 && /<daily_monitoring_playbook>|<agent_rules>|<INSTRUCTIONS>/.test(text)) {
    return summarizeLongPrompt(text);
  }
  return truncateTitle(text);
}

function summarizeLongPrompt(text) {
  const candidates = [
    /你是[“"]([^”"]+)[”"]/,
    /核心问题：\s*>?\s*([^<。]+[。]?)/,
    /^(.{1,80}?)(?:。|\.|\n)/,
  ];

  for (const pattern of candidates) {
    const match = text.match(pattern);
    if (match?.[1]) return truncateTitle(match[1]);
  }

  return truncateTitle(text);
}

function truncateTitle(text) {
  const max = 72;
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function readFirstLine(file) {
  return new Promise((resolve) => {
    let data = "";
    const stream = fsSync.createReadStream(file, { encoding: "utf8", highWaterMark: 4096 });
    stream.on("data", (chunk) => {
      data += chunk;
      const index = data.indexOf("\n");
      if (index !== -1) {
        stream.destroy();
        resolve(data.slice(0, index));
      }
      if (data.length > 64_000) {
        stream.destroy();
        resolve(data);
      }
    });
    stream.on("end", () => resolve(data));
    stream.on("error", () => resolve(""));
  });
}

function sessionIdFromFilename(file) {
  const match = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})/i);
  return match ? match[1] : "";
}

function projectFromCwd(cwd) {
  if (!cwd) return "";
  const relative = path.relative(WORKSPACE_ROOT, cwd);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return cwd;
  return relative || ".";
}

function send(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function broadcast(session, type, payload) {
  for (const client of session.clients) send(client, type, payload);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function parseOutputRevision(value) {
  if (value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function optionalNonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function execFileText(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 5000 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`);
    });
  });
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function cleanupUploadedFiles(files) {
  await Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
}

function cleanUploadOriginalName(value) {
  const normalized = String(value || "upload")
    .replace(/\\/g, "/")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .normalize("NFC");
  const basename = path.basename(normalized).trim();
  const safeName = !basename || basename === "." || basename === ".." ? "upload" : basename;
  return truncateUploadName(safeName, 180);
}

function reserveUploadFile(uploadDir, originalName) {
  for (let duplicate = 0; duplicate < 1000; duplicate += 1) {
    const storedName = duplicateUploadName(originalName, duplicate);
    const filePath = path.join(uploadDir, storedName);

    try {
      const fd = fsSync.openSync(filePath, "wx", 0o600);
      const output = fsSync.createWriteStream(filePath, { fd, autoClose: true });
      return { storedName, filePath, output };
    } catch (error) {
      if (error.code === "EEXIST") continue;
      throw error;
    }
  }

  throw new Error("too many files with the same name");
}

function duplicateUploadName(originalName, duplicate) {
  if (!duplicate) return originalName;

  const maxBytes = 180;
  const suffix = `-${duplicate + 1}`;
  const extension = path.extname(originalName);
  const stem = extension ? originalName.slice(0, -extension.length) : originalName;
  const safeExtension = Buffer.byteLength(extension) < maxBytes / 2 ? extension : "";
  const stemBudget = maxBytes - Buffer.byteLength(suffix) - Buffer.byteLength(safeExtension);
  const truncatedStem = truncateUtf8(stem, stemBudget) || "upload";
  return `${truncatedStem}${suffix}${safeExtension}`;
}

function truncateUploadName(value, maxBytes) {
  if (Buffer.byteLength(value) <= maxBytes) return value;

  const extension = path.extname(value);
  const stem = extension ? value.slice(0, -extension.length) : value;
  const extensionBytes = Buffer.byteLength(extension);
  const safeExtension = extensionBytes < maxBytes / 2 ? extension : "";
  const stemBudget = maxBytes - Buffer.byteLength(safeExtension);
  const truncatedStem = truncateUtf8(stem, stemBudget);

  return `${truncatedStem || "upload"}${safeExtension}`;
}

function truncateUtf8(value, maxBytes) {
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character) > maxBytes) break;
    result += character;
  }
  return result;
}

function dateDirectoryName(date) {
  return date.toISOString().slice(0, 10);
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}
