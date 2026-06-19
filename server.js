import { createRequire } from "node:module";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
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
const AUTH_COOKIE = "agent_auth";
const AUTH_MAX_AGE_SECONDS = Number(process.env.AUTH_MAX_AGE_SECONDS || 30 * 24 * 60 * 60);
const AUTH_BCRYPT_HASH = process.env.AGENT_AUTH_BCRYPT_HASH || "";
const AUTH_SECRET = process.env.AGENT_AUTH_SECRET || crypto.randomBytes(32).toString("hex");
const CODEX_SESSIONS_ROOT = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "sessions");
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

app.get("/api/auth", (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

app.post("/api/login", async (req, res) => {
  if (!AUTH_BCRYPT_HASH) {
    res.status(503).json({ error: "Auth is not configured." });
    return;
  }

  const password = String(req.body?.password || "");
  const ok = await bcrypt.compare(password, AUTH_BCRYPT_HASH);
  if (!ok) {
    res.status(401).json({ error: "Invalid password." });
    return;
  }

  res.setHeader("Set-Cookie", serializeAuthCookie(createAuthToken(), req));
  res.json({ authenticated: true });
});

app.post("/api/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ authenticated: false });
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
  const codexSessions = await listCodexSessions();
  res.json({ sessions: codexSessions });
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

wss.on("connection", (ws, req) => {
  if (!isAuthenticated(req)) {
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

function requireAuth(req, res, next) {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "Not authenticated." });
}

function isAuthenticated(req) {
  const token = parseCookies(req.headers.cookie || "")[AUTH_COOKIE];
  return Boolean(token && verifyAuthToken(token));
}

function createAuthToken() {
  const payload = Buffer.from(
    JSON.stringify({ exp: Date.now() + AUTH_MAX_AGE_SECONDS * 1000 }),
    "utf8",
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAuthToken(token) {
  const [payload, signature] = String(token).split(".");
  if (!payload || !signature) return false;

  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function serializeAuthCookie(token, req) {
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted;
  return [
    `${AUTH_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${AUTH_MAX_AGE_SECONDS}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

function parseCookies(cookieHeader) {
  const cookies = {};
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
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
        writeAndSubmit(session, normalized, { paste: true });
        session.lastActivityAt = new Date().toISOString();
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

async function listCodexSessions() {
  const files = await walkFiles(CODEX_SESSIONS_ROOT);
  const items = [];

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const meta = await readCodexSessionMeta(file);
    if (meta) items.push(meta);
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

async function readCodexSessionMeta(file) {
  const firstLine = await readFirstLine(file);
  if (!firstLine) return null;

  try {
    const parsed = JSON.parse(firstLine);
    const payload = parsed.payload || {};
    const id = payload.id || sessionIdFromFilename(file);
    const cwd = payload.cwd || "";
    const stat = await fs.stat(file);
    const title = await readCodexSessionTitle(file);
    return {
      id,
      title,
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
