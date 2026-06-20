import { createRequire } from "node:module";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
const MAX_RAW_BUFFER = 1024 * 1024;
const MAX_TEXT_BUFFER = 200_000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/terminal" });
const sessions = new Map();

app.use(express.json());
app.use("/", express.static(path.join(__dirname, "public")));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "lib")));
app.use("/vendor/xterm-css", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "css")));
app.use(
  "/vendor/xterm-fit",
  express.static(path.join(__dirname, "node_modules", "@xterm", "addon-fit", "lib")),
);

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
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    workspaceRoot: WORKSPACE_ROOT,
    projects,
  });
});

app.get("/api/sessions", (_req, res) => {
  res.json({
    ttlMs: SESSION_TTL_MS,
    sessions: [...sessions.values()].filter((session) => !session.exited).map(publicSession),
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
      if (session.sessionId === id && title) session.title = title;
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
  if (!(await isAuthenticated(req))) {
    send(ws, "error", { message: "Not authenticated." });
    ws.close();
    return;
  }

  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const attachId = String(url.searchParams.get("attach") || "").trim();

  let session = attachId ? sessions.get(attachId) : null;
  if (!session) {
    const cwd = resolveWorkspacePath(url.searchParams.get("cwd") || ".");
    const launch = getLaunchConfig(url.searchParams);

    if (!cwd) {
      send(ws, "error", { message: "Invalid cwd outside workspace root." });
      ws.close();
      return;
    }

    if (!launch) {
      send(ws, "error", { message: "Invalid launch mode or session ID." });
      ws.close();
      return;
    }

    launch.title = await titleForLaunch(launch);
    session = createSession(cwd, launch);
    if (session.error) {
      send(ws, "error", { message: session.error });
      ws.close();
      return;
    }
  }

  attachClient(session, ws);
});

server.listen(PORT, HOST, () => {
  console.log(`Agent Terminal Web: http://${HOST}:${PORT}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  console.log(`Detached session TTL: ${Math.round(SESSION_TTL_MS / 60000)} minutes`);
});

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

function createSession(cwd, launch) {
  const id = cryptoRandomId();
  const startedAt = new Date().toISOString();
  const shell = process.env.CODEX_COMMAND || "codex";
  const env = {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  };

  let terminal;
  try {
    terminal = pty.spawn(shell, launch.args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd,
      env,
    });
  } catch (error) {
    return { error: `Failed to start codex: ${error.message}` };
  }

  const session = {
    id,
    cwd,
    project: path.relative(WORKSPACE_ROOT, cwd) || ".",
    pid: terminal.pid,
    command: shell,
    args: launch.args,
    mode: launch.mode,
    sessionId: launch.sessionId,
    title: launch.title || "",
    terminal,
    clients: new Set(),
    cleanupTimer: null,
    exited: false,
    exitCode: null,
    signal: null,
    rawBuffer: "",
    textBuffer: "",
    startedAt,
    lastActivityAt: startedAt,
    cols: 100,
    rows: 30,
  };
  sessions.set(id, session);

  terminal.onData((data) => {
    session.lastActivityAt = new Date().toISOString();
    appendBuffers(session, data);
    broadcast(session, "output", { raw: data, text: stripAnsi(data) });
    broadcast(session, "status", publicSession(session));
  });

  terminal.onExit(({ exitCode, signal }) => {
    session.exited = true;
    session.exitCode = exitCode;
    session.signal = signal;
    broadcast(session, "status", publicSession(session));
    for (const client of session.clients) client.close();
    scheduleCleanup(session);
  });

  return session;
}

function attachClient(session, ws) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  session.clients.add(ws);
  send(ws, "status", publicSession(session));
  if (session.rawBuffer) send(ws, "replay", { raw: session.rawBuffer, text: session.textBuffer });

  ws.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (session.exited) return;

    if (message.type === "input" && typeof message.data === "string") {
      session.terminal.write(message.data);
      session.lastActivityAt = new Date().toISOString();
      return;
    }

    if (message.type === "submit" && typeof message.data === "string") {
      const normalized = message.data.trim();
      if (normalized) {
        if (!session.title) session.title = cleanTitle(normalized) || "New Codex session";
        writeAndSubmit(session, normalized, { paste: true });
        session.lastActivityAt = new Date().toISOString();
        broadcast(session, "status", publicSession(session));
      }
      return;
    }

    if (message.type === "command" && typeof message.data === "string") {
      writeAndSubmit(session, message.data.trim(), { paste: false });
      session.lastActivityAt = new Date().toISOString();
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
      session.terminal.kill();
    }
  });

  ws.on("close", () => {
    session.clients.delete(ws);
    if (session.clients.size === 0) scheduleCleanup(session);
  });
}

function scheduleCleanup(session) {
  if (session.cleanupTimer) return;
  session.cleanupTimer = setTimeout(() => {
    if (!session.exited) session.terminal.kill();
    sessions.delete(session.id);
  }, SESSION_TTL_MS);
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
  session.rawBuffer = trimStart(session.rawBuffer + raw, MAX_RAW_BUFFER);
  session.textBuffer = trimStart(session.textBuffer + stripAnsi(raw), MAX_TEXT_BUFFER);
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
  };
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

function stripAnsi(value) {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function trimStart(value, maxLength) {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
