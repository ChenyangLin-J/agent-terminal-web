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
import {
  CodexAppServerClient,
} from "./lib/codex-app-server-client.js";
import {
  PlatformAppServerClient,
  jsonFileBindingStore,
  platformKernelFor,
} from "./lib/platform-app-server-client.js";
import { AgentHostAppServerPool } from "./lib/agent-host-app-server.js";
import {
  agentHostProject,
  defaultAgentHostsFile,
  loadAgentHosts,
  publicAgentHost,
  resolveAgentHost,
  resolveAgentHostPath,
} from "./lib/agent-hosts.js";
import { readCodexMemoryStatus, readCodexMemoryView } from "./lib/codex-memories.js";
import {
  deletePersonalMemoryEntry,
  readPersonalMemoryView,
  updatePersonalMemoryEntry,
} from "./lib/personal-memories.js";
import {
  personalMemoryContextForPrompt,
  personalMemoryContextForPromptSync,
} from "./lib/personal-memory-context.js";
import { readProjectRuleDocuments } from "./lib/project-rule-documents.js";
import { orderKnowledgeChanges } from "./lib/knowledge-change-order.js";
import { memoryCitationFromToolItem } from "./lib/memory-access-citations.js";
import { createPersonalMemoryScheduler } from "./lib/personal-memory-scheduler.js";
import { readKnowledgeChanges } from "../memory-system/lib/change-ledger.js";
import { resolveKnowledgeChange } from "../memory-system/lib/knowledge-actions.js";
import {
  gardenLinkForLocalMarkdown,
  isPathInside,
  workspaceFileForLocalHref,
} from "./lib/local-file-link.js";
import {
  localFilePresentation,
  renderMarkdownEditorPage,
  renderMarkdownFilePage,
  renderSandboxFilePage,
  renderTextFilePage,
} from "./lib/local-file-view.js";
import {
  LocalMarkdownError,
  localMarkdownVersion,
  saveLocalMarkdownFile,
} from "./lib/local-markdown-file.js";
import {
  latestPersistedSessionsByCodexId,
  normalizeAccessMode,
  preferredAccessForCodexSession,
} from "./lib/session-access.js";
import {
  readAgentSessionFavorites,
  setAgentSessionFavorite,
} from "./lib/agent-session-favorites.js";
import { viewedImagePath } from "./lib/session-image.js";
import { commandDisplayText } from "./lib/command-display.js";
import {
  appServerConversationFromTurnPage,
  extractSessionConversationFromJsonl,
  extractSessionPreviewFromJsonl,
  extractSessionTokenUsageFromJsonl,
  readAppServerSessionConversation,
  readSessionPreviews,
  saveSessionPreview,
} from "./lib/session-preview.js";
import {
  extractSessionProcessFromJsonl,
  warmSessionProcessIndex,
} from "./lib/session-process.js";
import {
  normalizeShareMessages,
  renderSessionSharePage,
  renderUnavailableSessionSharePage,
  SessionShareStore,
} from "./lib/session-shares.js";
import {
  createCustomIntegrationCredential,
  deleteCustomIntegrationCredential,
  deleteIntegrationCredential,
  IntegrationError,
  listCustomIntegrations,
  listIntegrations,
  replaceCustomIntegrationCredential,
  saveIntegrationCredential,
} from "./lib/integrations.js";
import { createAmapMcpProxy } from "./lib/amap-mcp-proxy.js";
import { createPlaywrightMcpProxy } from "./lib/playwright-mcp-proxy.js";
import { buildAppServerTurnAdditionalContext } from "./lib/app-server-turn-context.js";
import {
  normalizeRemoteTurnCompletion,
  readRemoteNotificationTokens,
  resolveRemoteNotificationHost,
} from "./lib/remote-agent-notification.js";

const AGENT_TIME_ZONE = "Asia/Shanghai";
process.env.TZ = AGENT_TIME_ZONE;
const AGENT_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: AGENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKSPACE_ROOT = path.resolve(process.env.WORKSPACE_ROOT || path.join(__dirname, ".."));
const AGENT_HOSTS_FILE = path.resolve(process.env.AGENT_HOSTS_FILE || defaultAgentHostsFile());
const AGENT_HOSTS = loadAgentHosts({
  filePath: AGENT_HOSTS_FILE,
  localWorkspaceRoot: WORKSPACE_ROOT,
  localCodexCommand: process.env.CODEX_APP_SERVER_COMMAND || "codex",
});
const PERSONAL_AGENT_HOST = AGENT_HOSTS.find((host) => host.id === "personal");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3030);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 30 * 60 * 1000);
const AUTH_VERIFY_URL = process.env.PRIVATE_AUTH_VERIFY_URL || "http://127.0.0.1:3060/api/verify";
const AUTH_LOGIN_URL = process.env.PRIVATE_AUTH_LOGIN_URL || "https://auth.chenyanglin.com/login";
const AUTH_LOGOUT_URL = process.env.PRIVATE_AUTH_LOGOUT_URL || "https://auth.chenyanglin.com/logout";
const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.HOME, ".codex");
const CODEX_SESSIONS_ROOT = path.join(CODEX_HOME, "sessions");
const CODEX_ARCHIVED_SESSIONS_ROOT = path.join(CODEX_HOME, "archived_sessions");
const CODEX_SESSION_TITLES_FILE = path.join(CODEX_HOME, "session-titles.json");
const CODEX_SESSION_ARCHIVE_FILE = path.join(CODEX_HOME, "session-archive.json");
const AGENT_WEB_SESSIONS_FILE = path.join(CODEX_HOME, "agent-web-sessions.json");
const AGENT_SESSION_SETTINGS_FILE = path.join(CODEX_HOME, "agent-session-settings.json");
const CODEX_SESSION_PREVIEWS_FILE = path.join(CODEX_HOME, "agent-session-previews.json");
const CODEX_SESSION_PROCESS_INDEX_ROOT = path.join(CODEX_HOME, "agent-session-process-index");
const AGENT_SESSION_FAVORITES_FILE = path.resolve(
  process.env.AGENT_SESSION_FAVORITES_FILE ||
    path.join(path.dirname(CODEX_HOME), ".local", "share", "home-portal", "agent-session-favorites.json"),
);
const AGENT_SESSION_SHARES_FILE = path.resolve(
  process.env.AGENT_SESSION_SHARES_FILE ||
    path.join(path.dirname(CODEX_HOME), ".local", "share", "agent-terminal-web", "session-shares.json"),
);
const AGENT_HOST_STATE_DIR = path.resolve(
  process.env.AGENT_HOST_STATE_DIR ||
    path.join(path.dirname(AGENT_HOSTS_FILE), "host-state"),
);
const AGENT_REMOTE_NOTIFY_TOKENS_FILE = path.resolve(
  process.env.AGENT_REMOTE_NOTIFY_TOKENS_FILE ||
    path.join(path.dirname(AGENT_HOSTS_FILE), "notify-tokens.json"),
);
const AGENT_REMOTE_NOTIFY_TOKENS = readRemoteNotificationTokens(
  AGENT_REMOTE_NOTIFY_TOKENS_FILE,
);
const AGENT_INTEGRATIONS_DIR = path.resolve(
  process.env.AGENT_INTEGRATIONS_DIR ||
    path.join(process.env.HOME, ".config", "agent-terminal-web", "integrations"),
);
const AGENT_CUBOX_CONFIG_DIR = path.resolve(
  (process.env.NODE_ENV === "test" ? process.env.AGENT_CUBOX_CONFIG_DIR : "") ||
    path.join(process.env.HOME, ".config", "cubox-cli"),
);
const AGENT_CUBOX_ENVIRONMENT = Object.freeze({
  server: Boolean(process.env.CUBOX_SERVER),
  token: Boolean(process.env.CUBOX_TOKEN),
});
const UPLOADS_ROOT = path.resolve(process.env.UPLOADS_ROOT || path.join(WORKSPACE_ROOT, "uploads"));
const OBSIDIAN_VAULT_ROOT = path.resolve(
  process.env.OBSIDIAN_VAULT_PATH || path.join(WORKSPACE_ROOT, "obsidian", "MainVault"),
);
const GARDEN_BASE_URL = process.env.GARDEN_BASE_URL || "https://garden.chenyanglin.com";
const MAX_UPLOAD_FILES = Number(process.env.MAX_UPLOAD_FILES || 5);
const MAX_UPLOAD_FILE_BYTES = Number(process.env.MAX_UPLOAD_FILE_BYTES || 50 * 1024 * 1024);
const MAX_LOCAL_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_LOCAL_PREVIEW_BYTES = 50 * 1024 * 1024;
const MAX_RAW_BUFFER = 1024 * 1024;
const MAX_FULL_REPLAY_BYTES = 32 * 1024;
const MAX_TURN_REQUIREMENTS = 20;
const APP_INITIAL_TURN_LIMIT = 10;
const APP_HISTORY_PAGE_LIMIT = 10;
const APP_SEARCH_RESULT_LIMIT = 30;
const APP_SEARCH_HYDRATE_PAGE_LIMIT = 25;
const APP_SEARCH_HYDRATE_MAX_TURNS = 250;
const SESSION_SHARE_PAGE_LIMIT = 50;
const SESSION_SHARE_MAX_TURNS = 500;
const SESSION_SHARE_PRUNE_MS = 60_000;
const APP_THREAD_TREE_PAGE_LIMIT = 100;
const APP_THREAD_TREE_MAX_THREADS = 800;
const REALTIME_AUDIO_MAX_BASE64_CHARS = 196_608;
const REALTIME_SAMPLE_RATE_MIN = 8_000;
const REALTIME_SAMPLE_RATE_MAX = 48_000;
const REALTIME_SDP_MAX_CHARS = 262_144;
const REALTIME_V3_VOICES = Object.freeze([
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
]);
const DEFAULT_REALTIME_V3_VOICE = REALTIME_V3_VOICES[0];
const MAX_APP_TRANSCRIPT_ITEMS = 4_000;
const MAX_APP_TRANSCRIPT_TEXT = 200_000;
const MAX_APP_TRANSCRIPT_DETAIL = 40_000;
const MAX_APP_TRANSCRIPT_OUTPUT = 80_000;
const WS_HEARTBEAT_MS = Number(process.env.WS_HEARTBEAT_MS || 25_000);
const USE_TMUX_SESSIONS = process.env.AGENT_USE_TMUX === "1";
const SHARED_APP_SERVER_ENABLED = process.env.AGENT_SHARED_APP_SERVER !== "0";
const PLATFORM_KERNEL_MODE = String(process.env.AGENT_PLATFORM_KERNEL || "").trim().toLowerCase();
const PLATFORM_KERNEL_NEW_SESSIONS = ["1", "true", "new", "all"].includes(PLATFORM_KERNEL_MODE);
const PLATFORM_KERNEL_ALL = PLATFORM_KERNEL_MODE === "all";
const PLATFORM_KERNEL_FORCE_LEGACY = ["legacy", "off", "0", "false"].includes(PLATFORM_KERNEL_MODE);
const PLATFORM_BINDINGS_FILE = path.join(
  CODEX_HOME,
  "agent-web-platform-bindings.json",
);
const CODEX_NOTIFY_SCRIPT = path.join(__dirname, "scripts", "codex-notify.js");
const CODEX_GUARD_BIN = path.join(__dirname, "scripts", "codex-guard-bin");
const AGENT_NOTIFY_URL = process.env.AGENT_NOTIFY_URL || `http://${HOST}:${PORT}/internal/codex-notify`;
const PERSONAL_MEMORY_SETTLE_MS = Math.max(60_000, Number(process.env.PERSONAL_MEMORY_SETTLE_MS) || 60_000);
const CATALOG_APP_SERVER_IDLE_MS = Math.max(
  1_000,
  Number(process.env.AGENT_CATALOG_IDLE_MS) || 60_000,
);
const THREAD_CATALOG_CACHE_MS = Math.max(
  1_000,
  Number(process.env.AGENT_THREAD_CATALOG_CACHE_MS) || 2 * 60_000,
);
const CONTROL_EVENT_HEARTBEAT_MS = 25_000;
const REMOTE_AGENT_NOTIFY_RATE_LIMIT = 120;
const REMOTE_AGENT_NOTIFY_RATE_WINDOW_MS = 60_000;
const HOME_PUSH_URL = process.env.HOME_PUSH_URL || "http://127.0.0.1:3050/internal/push";
const HOME_PUSH_SUBSCRIBE_URL = process.env.HOME_PUSH_SUBSCRIBE_URL || `${HOME_PUSH_URL}/subscriptions`;
const HOME_VAPID_PUBLIC_KEY = process.env.HOME_VAPID_PUBLIC_KEY || "";
const APP_SERVER_TRANSPORT = "app-server";
const APP_SERVER_RELEASE_REASON_DETACHED_TTL = "detached-ttl";
const APP_SERVER_RELEASE_REASON_IDLE_TTL = "idle-ttl";
const FULL_ACCESS_MODE = "full";
const THINK_SESSION_PURPOSE = "think";
const THINKING_SKILL_INVOCATION = "$thinking-partner";
const APP_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];
const AUTO_ORCHESTRATION_ROLE_DEFAULTS = [
  {
    name: "explorer",
    description: "只读探索、日志排查和大范围检索",
    model: "gpt-5.6-terra",
    reasoningEffort: "medium",
  },
  {
    name: "worker",
    description: "边界清晰的实现任务",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
  {
    name: "reviewer",
    description: "高风险改动的只读复核",
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  },
];
const AGENT_WEB_DEVELOPER_INSTRUCTIONS = [
  "Agent Web service safety:",
  "- Never stop, restart, kill, or otherwise terminate agent-terminal-web.service from this Codex session, including through systemctl or an absolute executable path.",
  "- When Agent Web changes need deployment, finish verification, commit the changes, and tell the user that an external restart is required.",
  "- Do not restart Agent Web before sending the final answer. A restart terminates this turn and every other active web session.",
  "",
  "Agent Web multi-agent orchestration:",
  "- A per-turn <multi_agent_mode> marker declares either auto or manual mode.",
  "- Auto mode is the user's standing authorization to classify the task and delegate only when delegation is likely to save main-thread context or wall-clock time.",
  "- Handle conversation, decisions, simple questions, and small single-file work in the main agent without delegation.",
  "- Use one explorer for read-heavy repository discovery, broad search, logs, or unfamiliar execution paths. Explorer is read-only and uses gpt-5.6-terra at medium reasoning.",
  "- Use one worker for a bounded implementation with explicit file or module ownership. Set gpt-5.6-sol at high reasoning and tell it that other agents may be editing the codebase.",
  "- Add a reviewer only for security, auth, migration, concurrency, destructive operations, or other high-regression-risk changes. Reviewer is read-only and uses gpt-5.6-sol at high reasoning.",
  "- Default to at most one sub-agent. Use two concurrently only for independent work with non-overlapping ownership. Never delegate merely because agents are available.",
  "- The main agent owns scope, user communication, decisions, integration, and final verification. Avoid re-reading raw material already summarized by a sub-agent.",
  "- Manual mode forbids delegation unless the user explicitly asks for it in that task.",
].join("\n");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/terminal" });
server.prependListener("upgrade", (req) => {
  req.agentWebUpgradeStartedAt = Date.now();
  req.agentWebUpgradeLogFields = webSocketRequestLogFields(req);
  logAgentEvent("ws-upgrade-received", req.agentWebUpgradeLogFields);
});
const sessions = new Map();
const controlEventClients = new Set();
let remoteAgentNotifyRateWindow = { startedAt: Date.now(), requests: 0 };
const pendingSessionControlEvents = new Map();
const integrationMutationAttempts = new Map();
const sessionShareStore = new SessionShareStore(AGENT_SESSION_SHARES_FILE);
void pruneExpiredSessionShares();
const sessionSharePruneTimer = setInterval(pruneExpiredSessionShares, SESSION_SHARE_PRUNE_MS);
sessionSharePruneTimer.unref?.();
let catalogAppServerClient = null;
let catalogAppServerStart = null;
let catalogAppServerIdleTimer = null;
let catalogAppServerActiveUses = 0;
let agentHostAppServerPool = null;
const threadCatalogPageCache = new Map();
const codexSessionFileCache = new Map();
const sessionProcessIndexWarmQueue = new Map();
let sessionProcessIndexWarmTimer = null;
let sessionProcessIndexWarmRunning = false;
const agentInstanceId = cryptoRandomId();
const personalMemoryScheduler = createPersonalMemoryScheduler({
  delayMs: PERSONAL_MEMORY_SETTLE_MS,
  run: () => execFileOutput("systemctl", ["--user", "start", "--no-block", "personal-memory-worker.service"]),
  onError: (error) => logAgentEvent("personal-memory-trigger-failed", { message: error.message }),
});
const amapMcpProxy = createAmapMcpProxy({
  integrationRoot: AGENT_INTEGRATIONS_DIR,
  logger: logAgentEvent,
});
const playwrightMcpProxy = createPlaywrightMcpProxy({
  logger: logAgentEvent,
});

wss.on("error", (error) => {
  logAgentEvent("ws-server-error", {
    code: cleanClientLogValue(error.code, 80),
    message: cleanClientLogValue(error.message, 300),
  });
});

app.use(express.json());
app.get("/healthz", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Agent-Instance", agentInstanceId);
  res.type("text/plain").send("ok");
});
app.get("/share/:token", async (req, res) => {
  applyPublicShareHeaders(res);
  const share = await sessionShareStore.resolve(String(req.params.token || ""));
  if (!share) {
    res.status(410).type("html").send(renderUnavailableSessionSharePage());
    return;
  }
  res.type("html").send(renderSessionSharePage(share));
});
app.use("/shared", express.static(path.join(WORKSPACE_ROOT, "shared-web")));
app.use("/", express.static(path.join(__dirname, "public")));
app.use("/vendor/xterm", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "lib")));
app.use("/vendor/xterm-css", express.static(path.join(__dirname, "node_modules", "@xterm", "xterm", "css")));
app.use(
  "/vendor/xterm-fit",
  express.static(path.join(__dirname, "node_modules", "@xterm", "addon-fit", "lib")),
);
app.use("/vendor/markdown-it", express.static(path.join(__dirname, "node_modules", "markdown-it", "dist")));

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
  if (isValidSessionId(threadId)) {
    session.sessionId = threadId;
    rememberAgentSessionAccess(threadId, session.access, session.hostId);
  }
  persistCompletedSessionPreview(session, event["last-assistant-message"]);
  const completedTurnId = cleanTurnId(event["turn-id"]);
  completeTrackedTurn(session, completedTurnId);
  session.lastActivityAt = new Date().toISOString();
  rememberAgentSessionCompletion(
    threadId || session.sessionId,
    completedTurnId,
    session.lastActivityAt,
    session.hostId,
  );
  resetDetachedCleanupAfterWork(session);
  persistRestorableWebSession(session);
  broadcast(session, "status", publicSession(session));
  scheduleSessionProcessIndexWarm(session);
  if (session.hostId === PERSONAL_AGENT_HOST.id) {
    personalMemoryScheduler.schedule(threadId || session.id);
  }

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

app.post("/internal/remote-agent-notify", async (req, res) => {
  if (!acceptRemoteAgentNotificationRequest()) {
    res.status(429).json({ error: "Remote notification rate limit exceeded." });
    return;
  }
  const agentHost = resolveRemoteNotificationHost({
    authorization: req.get("authorization"),
    hosts: AGENT_HOSTS,
    tokens: AGENT_REMOTE_NOTIFY_TOKENS,
  });
  if (!agentHost) {
    res.status(401).json({ error: "Remote notification is not authorized." });
    return;
  }

  const completion = normalizeRemoteTurnCompletion(req.body);
  if (!completion) {
    res.status(400).json({ error: "Invalid remote completion event." });
    return;
  }

  if (hasRememberedAgentSessionCompletion(completion.threadId, completion.turnId, agentHost.id)) {
    res.json({ ok: true, duplicate: true });
    return;
  }

  const state = rememberAgentSessionCompletion(
    completion.threadId,
    completion.turnId,
    completion.completedAt,
    agentHost.id,
  );
  invalidateThreadCatalog(agentHost);
  emitControlEvent({
    type: "remote-completion",
    hostId: agentHost.id,
    sessionId: completion.threadId,
    turnId: completion.turnId,
    completedAt: completion.completedAt,
  });

  const managedLiveSession = [...sessions.values()].some(
    (session) =>
      !session.exited &&
      session.hostId === agentHost.id &&
      session.sessionId === completion.threadId,
  );
  let notification = managedLiveSession
    ? { sent: 0, subscriptionCount: 0, skipped: "managed-live-session" }
    : { sent: 0, subscriptionCount: 0 };
  if (!managedLiveSession) {
    try {
      notification = await sendRemoteAgentTurnNotification(agentHost, completion);
    } catch (error) {
      logAgentEvent("remote-turn-notification-failed", {
        hostId: agentHost.id,
        codexSessionId: completion.threadId,
        turnId: completion.turnId,
        message: cleanClientLogValue(error.message, 300),
      });
    }
  }
  logAgentEvent("remote-turn-completed", {
    hostId: agentHost.id,
    codexSessionId: completion.threadId,
    turnId: completion.turnId,
    sent: notification.sent,
    subscriptionCount: notification.subscriptionCount,
  });
  res.json({ ok: true, state, notification });
});

app.post("/internal/mcp/amap", async (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  await amapMcpProxy.handlePost(req, res);
});

app.get("/internal/mcp/amap", (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  amapMcpProxy.handleUnsupported(req, res);
});

app.delete("/internal/mcp/amap", (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  amapMcpProxy.handleUnsupported(req, res);
});

app.post("/internal/mcp/playwright", async (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  await playwrightMcpProxy.handlePost(req, res);
});

app.get("/internal/mcp/playwright", (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  playwrightMcpProxy.handleUnsupported(req, res);
});

app.delete("/internal/mcp/playwright", (req, res) => {
  if (!isDirectLoopbackRequest(req)) {
    res.sendStatus(404);
    return;
  }
  playwrightMcpProxy.handleUnsupported(req, res);
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

app.get("/open/local", async (req, res) => {
  if (!(await isAuthenticated(req))) {
    const next = new URL(req.originalUrl, getOrigin(req)).href;
    res.redirect(loginUrlForNext(req, next));
    return;
  }
  res.set("X-Content-Type-Options", "nosniff");

  const requested = workspaceFileForLocalHref(req.query.path, WORKSPACE_ROOT);
  if (!requested) {
    res.status(404).send("This local file cannot be opened in Agent.");
    return;
  }

  try {
    const [realWorkspaceRoot, realFilePath] = await Promise.all([
      fs.realpath(WORKSPACE_ROOT),
      fs.realpath(requested.filePath),
    ]);
    if (!isPathInside(realWorkspaceRoot, realFilePath)) throw new Error("File is outside the workspace");
    const stat = await fs.stat(realFilePath);
    if (!stat.isFile()) throw new Error("Not a file");

    const name = path.basename(requested.filePath);
    if (req.query.download === "1") {
      res.download(realFilePath, name);
      return;
    }

    const gardenHref = `${requested.filePath}${requested.fragment ? `#${requested.fragment}` : ""}`;
    const gardenLink = gardenLinkForLocalMarkdown(gardenHref, {
      vaultRoot: OBSIDIAN_VAULT_ROOT,
      gardenBaseUrl: GARDEN_BASE_URL,
    });
    if (gardenLink && req.query.edit !== "1") {
      res.redirect(gardenLink.href);
      return;
    }

    const presentation = localFilePresentation(realFilePath, stat.size, {
      maxTextBytes: MAX_LOCAL_TEXT_BYTES,
      maxPreviewBytes: MAX_LOCAL_PREVIEW_BYTES,
    });
    if (presentation.kind === "inline") {
      res.type(presentation.mime);
      res.sendFile(realFilePath);
      return;
    }
    if (presentation.kind === "download") {
      res.download(realFilePath, name);
      return;
    }

    const source = await fs.readFile(realFilePath, "utf8");
    const relativePath = path.relative(realWorkspaceRoot, realFilePath);
    const downloadHref = `/open/local?path=${encodeURIComponent(requested.filePath)}&download=1`;
    const sourceHref = `/open/local?path=${encodeURIComponent(requested.filePath)}&raw=1`;
    const editHref = `/open/local?path=${encodeURIComponent(requested.filePath)}&edit=1`;
    const viewHref = `/open/local?path=${encodeURIComponent(requested.filePath)}`;
    const editingMarkdown = presentation.kind === "markdown" && req.query.edit === "1";
    const page =
      presentation.kind === "sandbox"
        ? renderSandboxFilePage({ name, relativePath, source, downloadHref })
        : editingMarkdown
          ? renderMarkdownEditorPage({
              name,
              relativePath,
              text: source,
              version: localMarkdownVersion(source),
              saveHref: `/api/local-markdown?path=${encodeURIComponent(requested.filePath)}`,
              viewHref,
            })
        : presentation.kind === "markdown" && req.query.raw !== "1" && !requested.line
          ? renderMarkdownFilePage({
              name,
              relativePath,
              filePath: realFilePath,
              workspaceRoot: realWorkspaceRoot,
              text: source,
              downloadHref,
              sourceHref,
              editHref,
            })
        : renderTextFilePage({ name, relativePath, text: source, line: requested.line, downloadHref });
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-src 'self'; ${editingMarkdown ? "script-src 'self'; " : ""}base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    res.set("Cache-Control", "private, no-store");
    res.set("X-Frame-Options", "DENY");
    res.type("html").send(page);
  } catch {
    res.status(404).send("This local file no longer exists.");
  }
});

app.use("/api", requireAuth);

app.put(
  "/api/local-markdown",
  requireSameOriginMutation,
  express.text({ type: "text/plain", limit: MAX_LOCAL_TEXT_BYTES }),
  async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    const requested = workspaceFileForLocalHref(req.query.path, WORKSPACE_ROOT);
    if (!requested || path.extname(requested.filePath).toLowerCase() !== ".md") {
      res.status(404).json({ error: "这个 Markdown 文件不能在 Agent 中编辑。" });
      return;
    }
    if (!req.is("text/plain") || typeof req.body !== "string") {
      res.status(415).json({ error: "保存内容必须是 Markdown 纯文本。" });
      return;
    }

    try {
      const [realWorkspaceRoot, realFilePath] = await Promise.all([
        fs.realpath(WORKSPACE_ROOT),
        fs.realpath(requested.filePath),
      ]);
      if (!isPathInside(realWorkspaceRoot, realFilePath)) throw new Error("File is outside the workspace");
      const result = await saveLocalMarkdownFile({
        filePath: realFilePath,
        text: req.body,
        expectedVersion: req.get("if-match"),
        maxBytes: MAX_LOCAL_TEXT_BYTES,
      });
      logAgentEvent("local-markdown-saved", {
        path: path.relative(realWorkspaceRoot, realFilePath),
      });
      res.json({
        ok: true,
        version: result.version,
        href: `/open/local?path=${encodeURIComponent(requested.filePath)}`,
      });
    } catch (error) {
      if (error instanceof LocalMarkdownError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logAgentEvent("local-markdown-save-failed", {
        path: cleanClientLogValue(requested.relativePath, 200),
        message: cleanClientLogValue(error?.message, 200),
      });
      res.status(404).json({ error: "这个 Markdown 文件已经不存在或无法安全编辑。" });
    }
  },
);

app.get("/api/control-events", (req, res) => {
  res.set({
    "Cache-Control": "private, no-store",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  controlEventClients.add(res);
  writeControlEvent(res, { type: "ready", instanceId: agentInstanceId });
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), CONTROL_EVENT_HEARTBEAT_MS);
  heartbeat.unref?.();
  req.on("close", () => {
    clearInterval(heartbeat);
    controlEventClients.delete(res);
  });
});

app.get("/api/session-shares", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const sessionId = String(req.query.sessionId || "").trim();
  if (!isValidSessionId(sessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }
  try {
    const shares = await sessionShareStore.list({ hostId: agentHost.id, sessionId });
    res.set("Cache-Control", "private, no-store");
    res.json({ shares });
  } catch (error) {
    logAgentEvent("session-share-list-failed", {
      hostId: agentHost.id,
      codexSessionId: sessionId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(500).json({ error: "暂时无法读取分享状态。" });
  }
});

app.post("/api/session-shares", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const webSessionId = String(req.body?.webSessionId || "").trim();
  const requestedSessionId = String(req.body?.sessionId || "").trim();
  if (webSessionId && !isValidWebSessionId(webSessionId)) {
    res.status(400).json({ error: "Invalid web session id." });
    return;
  }
  if (requestedSessionId && !isValidSessionId(requestedSessionId)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }
  const liveSession = webSessionId ? sessions.get(webSessionId) : null;
  const session =
    liveSession &&
    !liveSession.exited &&
    (liveSession.hostId || PERSONAL_AGENT_HOST.id) === agentHost.id
      ? liveSession
      : null;
  const sessionId = String(requestedSessionId || session?.sessionId || "").trim();
  if (!isValidSessionId(sessionId)) {
    res.status(409).json({ error: "Session 历史尚未准备好，请稍后再试。" });
    return;
  }

  try {
    const canUseLiveSession =
      session?.transport === APP_SERVER_TRANSPORT &&
      session.ready &&
      session.sessionId === sessionId;
    const stored = canUseLiveSession
      ? { title: session.title, snapshot: await sessionShareSnapshot(session) }
      : await sessionShareSnapshotFromStoredThread(agentHost, sessionId);
    const snapshot = stored.snapshot;
    if (!snapshot.messages.length) {
      res.status(409).json({ error: "这个 Session 还没有可分享的用户消息和最终回答。" });
      return;
    }
    const created = await sessionShareStore.create({
      hostId: agentHost.id,
      sessionId,
      title: stored.title,
      messages: snapshot.messages,
      truncated: snapshot.truncated,
    });
    const url = new URL(`/share/${created.token}`, getOrigin(req)).toString();
    logAgentEvent("session-share-created", {
      shareId: created.share.id,
      hostId: agentHost.id,
      codexSessionId: sessionId,
      messageCount: created.share.messageCount,
      expiresAt: created.share.expiresAt,
    });
    res.set("Cache-Control", "private, no-store");
    res.status(201).json({ share: created.share, url });
  } catch (error) {
    logAgentEvent("session-share-create-failed", {
      webSessionId,
      hostId: agentHost.id,
      codexSessionId: sessionId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(500).json({ error: "静态快照暂时无法创建。" });
  }
});

app.delete("/api/session-shares/:id", async (req, res) => {
  const shareId = String(req.params.id || "").trim();
  try {
    const revoked = await sessionShareStore.revoke(shareId);
    if (!revoked) {
      res.status(404).json({ error: "这个分享链接已经失效。" });
      return;
    }
    logAgentEvent("session-share-revoked", { shareId });
    res.set("Cache-Control", "private, no-store");
    res.json({ id: shareId, revoked: true });
  } catch (error) {
    logAgentEvent("session-share-revoke-failed", {
      shareId: cleanClientLogValue(shareId, 40),
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(500).json({ error: "暂时无法撤销这个分享链接。" });
  }
});

app.get("/api/integrations", async (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  try {
    const [integrations, customIntegrations] = await Promise.all([
      listIntegrations({
        root: AGENT_INTEGRATIONS_DIR,
        cuboxConfigDir: AGENT_CUBOX_CONFIG_DIR,
        cuboxEnvironment: AGENT_CUBOX_ENVIRONMENT,
      }),
      listCustomIntegrations({ root: AGENT_INTEGRATIONS_DIR }),
    ]);
    res.json({
      integrations,
      customIntegrations,
    });
  } catch (error) {
    logAgentEvent("integration-status-failed", { message: cleanClientLogValue(error.message, 200) });
    res.status(500).json({ error: "暂时无法读取集成状态。" });
  }
});

app.post("/api/integrations/custom", requireSafeIntegrationMutation, async (req, res) => {
  try {
    const integration = await createCustomIntegrationCredential(req.body?.name, req.body?.key, {
      root: AGENT_INTEGRATIONS_DIR,
    });
    logAgentEvent("custom-integration-created", { integrationId: integration.id });
    res.set("Cache-Control", "private, no-store");
    res.status(201).json({ integration });
  } catch (error) {
    sendIntegrationError(res, error, "暂时无法保存这个 Key。");
  }
});

app.put(
  "/api/integrations/custom/:customIntegrationId",
  requireSafeIntegrationMutation,
  async (req, res) => {
    const integrationId = String(req.params.customIntegrationId || "");
    try {
      const integration = await replaceCustomIntegrationCredential(
        integrationId,
        req.body?.values?.key,
        { root: AGENT_INTEGRATIONS_DIR },
      );
      logAgentEvent("custom-integration-updated", { integrationId });
      res.set("Cache-Control", "private, no-store");
      res.json({ integration });
    } catch (error) {
      sendIntegrationError(res, error, "暂时无法替换这个 Key。");
    }
  },
);

app.delete(
  "/api/integrations/custom/:customIntegrationId",
  requireSafeIntegrationMutation,
  async (req, res) => {
    const integrationId = String(req.params.customIntegrationId || "");
    if (req.body?.confirm !== true) {
      res.status(400).json({ error: "删除 Key 需要明确确认。" });
      return;
    }
    try {
      const removed = await deleteCustomIntegrationCredential(integrationId, {
        root: AGENT_INTEGRATIONS_DIR,
      });
      logAgentEvent("custom-integration-deleted", { integrationId, removed });
      res.set("Cache-Control", "private, no-store");
      res.json({ ok: true, removed });
    } catch (error) {
      sendIntegrationError(res, error, "暂时无法删除这个 Key。");
    }
  },
);

app.put("/api/integrations/:integrationId", requireSafeIntegrationMutation, async (req, res) => {
  const integrationId = String(req.params.integrationId || "");
  try {
    const integration = await saveIntegrationCredential(integrationId, req.body?.values, {
      root: AGENT_INTEGRATIONS_DIR,
      cuboxConfigDir: AGENT_CUBOX_CONFIG_DIR,
      cuboxEnvironment: AGENT_CUBOX_ENVIRONMENT,
      confirmReplace: req.body?.confirmReplace === true,
    });
    if (integrationId === "amap") await amapMcpProxy.backend.close("credential-updated");
    logAgentEvent("integration-saved", { integrationId });
    res.set("Cache-Control", "private, no-store");
    res.json({ integration });
  } catch (error) {
    sendIntegrationError(res, error, "暂时无法保存这个集成。");
  }
});

app.delete("/api/integrations/:integrationId", requireSafeIntegrationMutation, async (req, res) => {
  const integrationId = String(req.params.integrationId || "");
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: "删除集成需要明确确认。" });
    return;
  }

  try {
    const removed = await deleteIntegrationCredential(integrationId, {
      root: AGENT_INTEGRATIONS_DIR,
      cuboxConfigDir: AGENT_CUBOX_CONFIG_DIR,
      cuboxEnvironment: AGENT_CUBOX_ENVIRONMENT,
    });
    if (integrationId === "amap") await amapMcpProxy.backend.close("credential-deleted");
    logAgentEvent("integration-deleted", { integrationId, removed });
    res.set("Cache-Control", "private, no-store");
    res.json({ ok: true, removed });
  } catch (error) {
    sendIntegrationError(res, error, "暂时无法删除这个集成。");
  }
});

app.get("/api/session-image/:sessionId/:itemId", async (req, res) => {
  const session = sessions.get(String(req.params.sessionId || ""));
  const itemId = String(req.params.itemId || "");
  const turnId = String(req.query.turnId || "");
  let filePath = viewedImagePath(session, itemId);
  if (
    !filePath &&
    session?.hostId === PERSONAL_AGENT_HOST.id &&
    session.sessionId &&
    isCodexTurnId(turnId)
  ) {
    try {
      session.historyProcessCache ||= new Map();
      if (!session.historyProcessCache.has(turnId)) {
        const items = await loadHistoricalSessionProcess(session, turnId);
        session.historyProcessCache.set(turnId, items);
      }
      filePath = viewedImagePath(session, itemId);
    } catch (error) {
      logAgentEvent("session-image-restore-failed", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        turnId,
        message: error.message,
      });
    }
  }
  if (!filePath) {
    res.status(404).send("This image is not available in the current Agent session.");
    return;
  }

  try {
    const realFilePath = await fs.realpath(filePath);
    const stat = await fs.stat(realFilePath);
    const presentation = localFilePresentation(realFilePath, stat.size, {
      maxTextBytes: MAX_LOCAL_TEXT_BYTES,
      maxPreviewBytes: MAX_LOCAL_PREVIEW_BYTES,
    });
    if (!stat.isFile() || presentation.kind !== "inline" || !presentation.mime.startsWith("image/")) {
      throw new Error("Not a supported image");
    }
    res.set("Cache-Control", "private, no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.type(presentation.mime);
    res.sendFile(realFilePath);
  } catch {
    res.status(404).send("This image no longer exists.");
  }
});

app.get("/api/session-process/:sessionId/:turnId", async (req, res) => {
  const session = sessions.get(String(req.params.sessionId || ""));
  const turnId = String(req.params.turnId || "");
  const isRestoredTurn = session?.appTranscript?.some(
    (item) => item.turnId === turnId && item.historical,
  );
  if (
    session?.hostId !== PERSONAL_AGENT_HOST.id ||
    !session.sessionId ||
    (!isRestoredTurn && !isCodexTurnId(turnId))
  ) {
    res.status(404).json({ error: "This historical turn is not available in the current Agent session." });
    return;
  }

  const startedAt = Date.now();
  try {
    session.historyProcessCache ||= new Map();
    const cached = session.historyProcessCache.has(turnId);
    if (!cached) {
      const items = await loadHistoricalSessionProcess(session, turnId);
      session.historyProcessCache.set(turnId, items);
    }
    const items = session.historyProcessCache.get(turnId) || [];
    logAgentEvent("session-process-load", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      turnId,
      cached,
      itemCount: items.length,
      durationMs: Date.now() - startedAt,
    });
    res.set("Cache-Control", "private, no-store");
    res.json({ items });
  } catch (error) {
    logAgentEvent("session-process-load-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      turnId,
      durationMs: Date.now() - startedAt,
      message: error.message,
    });
    res.status(404).json({ error: "The complete process for this turn is no longer available." });
  }
});

app.get("/api/hosts", (_req, res) => {
  res.set("Cache-Control", "private, no-store");
  res.json({
    defaultHostId: PERSONAL_AGENT_HOST.id,
    hosts: AGENT_HOSTS.map(publicAgentHost),
  });
});

app.get("/api/projects", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  if (agentHost.type === "ssh") {
    res.json({
      host: publicAgentHost(agentHost),
      workspaceRoot: agentHost.workspaceRoot,
      projects: agentHost.projects,
    });
    return;
  }

  const entries = await fs.readdir(agentHost.workspaceRoot, { withFileTypes: true });
  const projects = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "uploads")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  res.json({
    host: publicAgentHost(agentHost),
    workspaceRoot: agentHost.workspaceRoot,
    projects,
  });
});

app.get("/api/memories/status", async (_req, res) => {
  try {
    const [status, personal, knowledge] = await Promise.all([
      readCodexMemoryStatus(CODEX_HOME),
      readPersonalMemoryView(CODEX_HOME, { view: "overview" }),
      readKnowledgeChanges({ codexHome: CODEX_HOME, workspaceRoot: WORKSPACE_ROOT }),
    ]);
    personal.projectCatalog = mergeMemoryProjectCatalog(personal.projectCatalog, workspaceMemoryProjectNames());
    res.json({
      ...status,
      personal: {
        counts: personal.counts,
        importScope: personal.importScope,
        runtime: personal.runtime,
        projectCatalog: personal.projectCatalog,
      },
      knowledge: knowledgeChangeView(knowledge.changes, "status"),
    });
  } catch (error) {
    console.error(`Failed to read Codex memory status: ${error.message}`);
    res.status(500).json({ error: "Codex memory status is unavailable." });
  }
});

app.get("/api/memories", async (req, res) => {
  try {
    const options = {
      view: req.query.view,
      project: req.query.project,
      projects: req.query.projects,
      source: req.query.source,
    };
    const [native, personal, knowledge, projectRules] = await Promise.all([
      readCodexMemoryView(CODEX_HOME, options),
      readPersonalMemoryView(CODEX_HOME, options),
      readKnowledgeChanges({ codexHome: CODEX_HOME, workspaceRoot: WORKSPACE_ROOT }),
      options.view === "detail"
        ? readProjectRuleDocuments(WORKSPACE_ROOT)
        : Promise.resolve({ selectedProjects: [], documents: [] }),
    ]);
    personal.projectCatalog = mergeMemoryProjectCatalog(personal.projectCatalog, workspaceMemoryProjectNames());
    res.json({ ...native, personal, projectRules, knowledge: knowledgeChangeView(knowledge.changes, options.view) });
  } catch (error) {
    console.error(`Failed to read Codex memories: ${error.message}`);
    res.status(500).json({ error: "Codex memories are unavailable." });
  }
});

app.patch("/api/knowledge-changes/:id", async (req, res) => {
  try {
    const change = await resolveKnowledgeChange(
      req.params.id,
      String(req.body?.action || ""),
      req.body || {},
      { codexHome: CODEX_HOME, workspaceRoot: WORKSPACE_ROOT },
    );
    res.json({ change });
  } catch (error) {
    console.error(`Failed to resolve knowledge change: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: error.message || "知识变更操作失败。" });
  }
});

app.patch("/api/memories/:id", async (req, res) => {
  try {
    const entry = await updatePersonalMemoryEntry(CODEX_HOME, req.params.id, req.body || {});
    res.json({ entry });
  } catch (error) {
    console.error(`Failed to update personal memory: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: error.message || "记忆修改失败。" });
  }
});

app.delete("/api/memories/:id", async (req, res) => {
  try {
    const entry = await deletePersonalMemoryEntry(CODEX_HOME, req.params.id);
    res.json({ entry });
  } catch (error) {
    console.error(`Failed to delete personal memory: ${error.message}`);
    res.status(error.statusCode || 500).json({ error: error.message || "记忆删除失败。" });
  }
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
      path: cleanClientEventPath(req.body?.path),
      hostId: cleanClientLogValue(req.body?.hostId, 40),
      replayMode: cleanClientLogValue(req.body?.replayMode, 20),
      rawChars: optionalNonNegativeInteger(req.body?.rawChars),
      outputRevision: optionalNonNegativeInteger(req.body?.outputRevision),
      expectedRevision: optionalNonNegativeInteger(req.body?.expectedRevision),
      receivedRevision: optionalNonNegativeInteger(req.body?.receivedRevision),
      durationMs: optionalNonNegativeInteger(req.body?.durationMs),
      reconnect: typeof req.body?.reconnect === "boolean" ? req.body.reconnect : undefined,
      reconnectAttempt: optionalNonNegativeInteger(req.body?.reconnectAttempt),
      phase: cleanClientLogValue(req.body?.phase, 30),
    });
  }
  res.json({ ok: true });
});

app.get("/api/sessions", (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const favoriteSessionIds = favoriteSessionIdsForHost(agentHost);
  const liveSessions = [...sessions.values()]
    .filter((session) => !session.exited && session.hostId === agentHost.id)
    .map(publicSession)
    .map((session) => ({
      ...session,
      favorited: favoriteSessionIds.has(session.sessionId),
    }));
  const restoredSessions = listDetachedSessions().filter(
    (session) => session.hostId === agentHost.id,
  ).filter(
    (session) => !sessions.has(session.id) && !liveSessions.some((liveSession) => liveSession.id === session.id),
  ).map((session) => ({
    ...session,
    favorited: favoriteSessionIds.has(session.sessionId),
  }));

  res.json({
    host: publicAgentHost(agentHost),
    ttlMs: SESSION_TTL_MS,
    sessions: [...liveSessions, ...restoredSessions],
  });
});

app.post("/api/sessions/:id/restart", (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!isValidWebSessionId(id)) {
    res.status(400).json({ error: "Invalid web session id." });
    return;
  }

  const session = sessions.get(id);
  if (!session || session.exited) {
    res.status(404).json({ error: "This Session is no longer running." });
    return;
  }
  if (!isValidSessionId(session.sessionId)) {
    res.status(409).json({ error: "This Session has not finished starting yet." });
    return;
  }

  const restart = {
    hostId: session.hostId || PERSONAL_AGENT_HOST.id,
    sessionId: session.sessionId,
    project: session.project,
    title: session.title,
    transport: session.transport,
    access: session.access,
    purpose: session.purpose,
  };
  logAgentEvent("session-restart", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    transport: session.transport,
    activeTurn: Boolean(session.turnState?.active),
  });
  session.ready = false;
  session.exited = true;
  broadcast(session, "status", publicSession(session));
  killSessionTerminal(session);
  res.json({ session: restart });
});

app.post("/api/sessions/:id/end", (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  if (!isValidWebSessionId(id)) {
    res.status(400).json({ error: "Invalid web session id." });
    return;
  }

  const session = sessions.get(id);
  if (session && !session.exited && session.hostId === agentHost.id) {
    logAgentEvent("session-end", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      activeTurn: Boolean(session.turnState?.active),
    });
    killSessionTerminal(session);
    res.json({ id, ended: true, session: publicSession(session) });
    return;
  }

  const detached = listDetachedSessions().find(
    (candidate) => candidate.id === id && candidate.hostId === agentHost.id,
  );
  if (detached) {
    removePersistedWebSession(id);
    res.json({ id, ended: true });
    return;
  }

  res.status(404).json({ error: "This Session is no longer current." });
});

app.get("/api/codex-sessions", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  try {
    const codexSessions = await listCodexSessions({ archived: false, agentHost });
    res.json({ host: publicAgentHost(agentHost), sessions: favoritedCodexSessions(codexSessions, agentHost) });
  } catch (error) {
    res.status(503).json({ host: publicAgentHost(agentHost), sessions: [], error: error.message });
  }
});

app.get("/api/codex-sessions/archived", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  try {
    const codexSessions = await listCodexSessions({ archived: true, agentHost });
    res.json({ host: publicAgentHost(agentHost), sessions: favoritedCodexSessions(codexSessions, agentHost) });
  } catch (error) {
    res.status(503).json({ host: publicAgentHost(agentHost), sessions: [], error: error.message });
  }
});

function favoritedCodexSessions(codexSessions, agentHost = PERSONAL_AGENT_HOST) {
  const favoriteSessionIds = favoriteSessionIdsForHost(agentHost);
  return codexSessions.map((session) => ({
    ...session,
    favorited: favoriteSessionIds.has(session.id),
  }));
}

app.get("/api/codex-sessions/search", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const searchTerm = cleanSearchTerm(req.query.q);
  if (!searchTerm) {
    res.json({ results: [] });
    return;
  }

  try {
    res.set("Cache-Control", "private, no-store");
    const results = await searchCodexSessions(searchTerm, agentHost);
    const favoriteSessionIds = favoriteSessionIdsForHost(agentHost);
    res.json({
      results: results.map((result) => ({
        ...result,
        session: {
          ...result.session,
          favorited: favoriteSessionIds.has(result.session?.id),
        },
      })),
    });
  } catch (error) {
    logAgentEvent("thread-search-failed", { message: cleanClientLogValue(error.message, 300) });
    res.status(502).json({ error: "Session 搜索暂时不可用。" });
  }
});

app.get("/api/sessions/:id/search", async (req, res) => {
  const session = sessions.get(String(req.params.id || ""));
  const searchTerm = cleanSearchTerm(req.query.q);
  if (!session || session.exited || session.transport !== APP_SERVER_TRANSPORT) {
    res.status(404).json({ error: "当前 App Server Session 已不可用。" });
    return;
  }
  if (!searchTerm) {
    res.json({ results: [], nextCursor: null });
    return;
  }

  try {
    let page;
    try {
      page = await session.appServer.searchThreadOccurrences(searchTerm, {
        limit: APP_SEARCH_RESULT_LIMIT,
        cursor: req.query.cursor ? String(req.query.cursor) : null,
      });
    } catch (error) {
      if (!/not supported yet/i.test(error.message)) throw error;
      page = await searchAppServerOccurrencesFallback(session, searchTerm);
    }
    res.set("Cache-Control", "private, no-store");
    res.json({
      results: Array.isArray(page?.data) ? page.data.map(publicThreadSearchOccurrence) : [],
      nextCursor: page?.nextCursor || null,
    });
  } catch (error) {
    logAgentEvent("thread-occurrence-search-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(502).json({ error: "当前会话搜索暂时不可用。" });
  }
});

app.post("/api/sessions/:id/search/load", async (req, res) => {
  const session = sessions.get(String(req.params.id || ""));
  const turnCursor = String(req.body?.turnCursor || "");
  const itemId = String(req.body?.itemId || "");
  if (!session || session.exited || session.transport !== APP_SERVER_TRANSPORT) {
    res.status(404).json({ error: "当前 App Server Session 已不可用。" });
    return;
  }
  if (!turnCursor || !itemId) {
    res.status(400).json({ error: "搜索结果缺少定位信息。" });
    return;
  }

  try {
    const loadedTurns = await hydrateAppServerSearchResult(session, turnCursor, itemId);
    res.set("Cache-Control", "private, no-store");
    res.json({ ok: true, itemId, loadedTurns });
  } catch (error) {
    logAgentEvent("thread-occurrence-load-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(502).json({ error: "无法加载这条搜索结果附近的历史。" });
  }
});

app.post("/api/sessions/:id/history/locate", async (req, res) => {
  const session = sessions.get(String(req.params.id || ""));
  const turnId = String(req.body?.turnId || "");
  const itemId = String(req.body?.itemId || "");
  if (!session || session.exited || session.transport !== APP_SERVER_TRANSPORT) {
    res.status(404).json({ error: "当前 App Server Session 已不可用。" });
    return;
  }
  if (!isCodexTurnId(turnId)) {
    res.status(400).json({ error: "阅读位置缺少有效的轮次信息。" });
    return;
  }

  try {
    const loadedTurns = await locateAppServerHistoryTurn(session, turnId, itemId);
    res.set("Cache-Control", "private, no-store");
    res.json({ ok: true, turnId, itemId, loadedTurns });
  } catch (error) {
    logAgentEvent("thread-reading-position-load-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      turnId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(502).json({ error: "无法恢复这条阅读位置。" });
  }
});

app.post("/api/sessions/:id/fork", async (req, res) => {
  const session = sessions.get(String(req.params.id || ""));
  const lastTurnId = String(req.body?.lastTurnId || "");
  if (!session || session.exited || session.transport !== APP_SERVER_TRANSPORT) {
    res.status(404).json({ error: "当前 App Server Session 已不可用。" });
    return;
  }
  if (!isCodexTurnId(lastTurnId)) {
    res.status(400).json({ error: "分支位置无效。" });
    return;
  }
  if (session.turnState.active || session.appServer.activeTurnId) {
    res.status(409).json({ error: "当前任务仍在处理中，完成后才能从这里分支。" });
    return;
  }

  try {
    const result = await forkAppServerSessionInBackground(session, lastTurnId);
    res.set("Cache-Control", "private, no-store");
    res.json(result);
  } catch (error) {
    logAgentEvent("thread-fork-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      lastTurnId,
      message: cleanClientLogValue(error.message, 300),
    });
    res.status(502).json({ error: `无法创建分支：${error.message}` });
  }
});

app.get("/api/session-preview/:id", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    const liveSource = liveSessionPreviewSource(req, agentHost);
    if (liveSource) {
      try {
        const live = await readLiveSessionPreview(liveSource, id);
        res.set("Cache-Control", "private, no-store");
        res.json(live);
        return;
      } catch (error) {
        logAgentEvent("live-session-preview-fallback", {
          webSessionId: liveSource.id,
          sourceThreadId: liveSource.sessionId,
          previewThreadId: id,
          message: cleanClientLogValue(error.message, 300),
        });
      }
    }

    if (agentHost.type !== "local") {
      const conversation = await withStandaloneAppServer(agentHost, (client) =>
        readAppServerSessionConversation(client, id, { limit: APP_INITIAL_TURN_LIMIT }),
      );
      const preview = sessionPreviewFromConversation(conversation);
      if (!preview && !conversation.turns.length) {
        if (liveSource) {
          res.set("Cache-Control", "private, no-store");
          res.json({
            preview: null,
            conversation: { turns: [], hasEarlier: false },
            transcript: { restoredTurnCount: 0, hasEarlierTurns: false, items: [] },
            live: true,
            active: true,
          });
          return;
        }
        res.status(404).json({ error: "No Session history is available yet." });
        return;
      }
      res.set("Cache-Control", "private, no-store");
      res.json({ preview, conversation, ...(liveSource ? { live: true, active: true } : {}) });
      return;
    }

    const cached = readSessionPreviews(CODEX_SESSION_PREVIEWS_FILE)[id];
    const file = await findCodexSessionFile(id);
    const conversation = file ? await extractSessionConversationFromJsonl(file, { limit: APP_INITIAL_TURN_LIMIT }) : null;
    const conversationPreview = sessionPreviewFromConversation(conversation);
    const extracted = newerSessionPreview(cached, conversationPreview) || (file ? await extractSessionPreviewFromJsonl(file) : null);
    if (!extracted && !conversation?.turns?.length) {
      if (liveSource) {
        res.set("Cache-Control", "private, no-store");
        res.json({
          preview: null,
          conversation: { turns: [], hasEarlier: false },
          transcript: { restoredTurnCount: 0, hasEarlierTurns: false, items: [] },
          live: true,
          active: true,
        });
        return;
      }
      res.status(404).json({ error: "No completed result is available yet." });
      return;
    }
    const preview = extracted
      ? extracted === cached
        ? cached
        : saveSessionPreview(CODEX_SESSION_PREVIEWS_FILE, { ...extracted, sessionId: id })
      : null;
    if (liveSource) res.set("Cache-Control", "private, no-store");
    res.json({
      preview,
      conversation: conversation || { turns: [], hasEarlier: false },
      ...(liveSource ? { live: true, active: true } : {}),
    });
  } catch (error) {
    console.error(`Failed to read session preview ${id}: ${error.message}`);
    res.status(agentHost.type === "local" ? 500 : 503).json({
      error:
        agentHost.type === "local"
          ? "Session preview is unavailable."
          : `${agentHost.label} Session 暂时无法读取，请确认远端设备在线后重试。`,
    });
  }
});

function liveSessionPreviewSource(req, agentHost) {
  const sourceId = String(req.query.sourceSession || "").trim();
  if (!isValidWebSessionId(sourceId)) return null;
  const session = sessions.get(sourceId);
  if (
    !session ||
    session.hostId !== agentHost.id ||
    session.transport !== APP_SERVER_TRANSPORT ||
    !session.ready ||
    session.exited ||
    session.released ||
    !session.appServer
  ) {
    return null;
  }
  return session;
}

async function readLiveSessionPreview(sourceSession, threadId) {
  const [page, thread] = await Promise.all([
    sourceSession.appServer.listThreadTurns({
      threadId,
      limit: APP_INITIAL_TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    }),
    sourceSession.appServer.readThread({ threadId, includeTurns: false }),
  ]);
  const turns = Array.isArray(page?.data) ? [...page.data] : [];
  const orderedTurns = turns.sort((left, right) => Number(left?.startedAt || 0) - Number(right?.startedAt || 0));
  const previewSession = {
    ...sourceSession,
    collabAgentMetadata: new Map(),
    personalMemoryCitationsByTurn: new Map(),
    submittedAttachmentMetadata: new Map(),
  };
  const transcriptItems = appTranscriptItemsFromTurns(previewSession, orderedTurns, { historical: false })
    .map(normalizeAppTranscriptItem);
  const conversation = appServerConversationFromTurnPage(page);
  return {
    preview: sessionPreviewFromConversation(conversation),
    conversation,
    transcript: {
      restoredTurnCount: new Set(transcriptItems.map((item) => item.turnId).filter(Boolean)).size,
      hasEarlierTurns: Boolean(page?.nextCursor),
      items: transcriptItems,
    },
    live: true,
    active: livePreviewThreadActive(thread, turns),
  };
}

function livePreviewThreadActive(thread, turns = []) {
  const rawStatus = thread?.status?.type || thread?.status || "";
  const status = String(rawStatus).replace(/[_-]/g, "").toLowerCase();
  if (["active", "inprogress", "running", "pending"].includes(status)) return true;
  const hasActiveTurn = turns.some((turn) => {
    const turnStatus = String(turn?.status?.type || turn?.status || "").replace(/[_-]/g, "").toLowerCase();
    return ["active", "inprogress", "running", "pending"].includes(turnStatus);
  });
  if (hasActiveTurn) return true;
  if (["idle", "completed", "failed", "interrupted", "cancelled", "canceled"].includes(status)) return false;
  return false;
}

function sessionPreviewFromConversation(conversation) {
  for (let turnIndex = (conversation?.turns?.length || 0) - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = conversation.turns[turnIndex];
    const answer = [...(turn.assistant || [])].reverse().find((item) => item.phase === "final_answer");
    if (!answer?.text) continue;
    return {
      sessionId: "preview",
      prompt: turn.user || "",
      result: answer.text,
      completedAt: answer.completedAt || new Date().toISOString(),
    };
  }
  return null;
}

function newerSessionPreview(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return new Date(right.completedAt || 0) > new Date(left.completedAt || 0) ? right : left;
}

app.put("/api/codex-sessions/:id/title", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  const title = cleanCustomTitle(req.body?.title);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    const nativeNameSaved = await setPersistedThreadName(id, title, agentHost).catch((error) => {
      logAgentEvent("thread-native-name-failed", {
        codexSessionId: id,
        message: cleanClientLogValue(error.message, 300),
      });
      return false;
    });
    if (agentHost.type === "local") {
      const titles = await readSessionTitles();
      if (title) {
        titles[id] = title;
      } else {
        delete titles[id];
      }
      await writeSessionTitles(titles);
    }
    for (const session of sessions.values()) {
      if (session.hostId === agentHost.id && session.sessionId === id && title) {
        session.title = title;
        persistRestorableWebSession(session);
        broadcast(session, "status", publicSession(session));
      }
    }
    invalidateThreadCatalog(agentHost);
    res.json({ id, customTitle: title, nativeNameSaved });
  } catch (error) {
    res.status(500).json({ error: `Failed to save title: ${error.message}` });
  }
});

app.put("/api/codex-sessions/:id/favorite", (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  const favorited = Boolean(req.body?.favorited);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    setAgentSessionFavorite(agentSessionFavoritesFile(agentHost), id, favorited);
    emitCatalogControlEvent(agentHost);
    res.json({ id, favorited });
  } catch (error) {
    res.status(500).json({ error: `Failed to update favorite: ${error.message}` });
  }
});

app.put("/api/codex-sessions/:id/archive", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  const archived = Boolean(req.body?.archived);
  const endLiveSession = archived && Boolean(req.body?.endLiveSession);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }

  try {
    if (endLiveSession) {
      for (const session of sessions.values()) {
        if (!session.exited && session.hostId === agentHost.id && session.sessionId === id) {
          killSessionTerminal(session);
        }
      }
    }
    await setSessionArchived(id, archived, agentHost);
    removePersistedWebSessionsForCodexSession(id, agentHost.id);
    res.json({ id, archived });
  } catch (error) {
    res.status(500).json({ error: `Failed to update archive: ${error.message}` });
  }
});

app.post("/api/codex-sessions/:id/viewed", (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const id = String(req.params.id || "").trim();
  const turnId = cleanTurnId(req.body?.turnId);

  if (!isValidSessionId(id)) {
    res.status(400).json({ error: "Invalid session id." });
    return;
  }
  if (!turnId) {
    res.status(400).json({ error: "A completed turn id is required." });
    return;
  }

  const state = rememberAgentSessionViewed(id, turnId, new Date().toISOString(), agentHost.id);
  for (const session of sessions.values()) {
    if (!session.exited && session.hostId === agentHost.id && session.sessionId === id) {
      broadcast(session, "status", publicSession(session));
    }
  }
  res.json({ id, ...state });
});

app.get("/api/git-status", async (req, res) => {
  const agentHost = requestAgentHost(req, res);
  if (!agentHost) return;
  const cwd = resolveAgentHostPath(agentHost, String(req.query.cwd || "."));
  if (!cwd) {
    res.status(400).json({ error: "cwd must stay inside the workspace root" });
    return;
  }
  if (agentHost.type === "ssh") {
    res.json({ hostId: agentHost.id, cwd, git: "远端 Git 状态将在连接 Session 后读取" });
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
  ws.agentWebUpgradeStartedAt = req.agentWebUpgradeStartedAt || Date.now();
  logAgentEvent("ws-upgrade-complete", {
    ...(req.agentWebUpgradeLogFields || webSocketRequestLogFields(req)),
    durationMs: webSocketElapsedMs(ws.agentWebUpgradeStartedAt),
  });
  registerWebSocketErrorHandler(ws, req);

  if (!(await isAuthenticated(req))) {
    logWebSocketReject(req, "not-authenticated");
    send(ws, "error", { message: "Not authenticated." });
    ws.close();
    return;
  }

  const url = new URL(req.url || "", `http://${req.headers.host}`);
  const attachId = String(url.searchParams.get("attach") || "").trim();
  const shouldReplay = url.searchParams.get("replay") !== "0";
  const afterRevision = parseOutputRevision(url.searchParams.get("afterRevision"));
  const clientId = cleanWebClientId(url.searchParams.get("clientId"));
  const requestedAgentHost = resolveAgentHost(AGENT_HOSTS, url.searchParams.get("host"));

  if (!requestedAgentHost) {
    logWebSocketReject(req, "invalid-host");
    send(ws, "error", { message: "Unknown Agent host." });
    ws.close();
    return;
  }

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

  if (session && session.hostId !== requestedAgentHost.id) {
    logWebSocketReject(req, "host-mismatch", {
      webSessionId: session.id,
      requestedHostId: requestedAgentHost.id,
      sessionHostId: session.hostId,
    });
    send(ws, "error", { message: "This Session belongs to a different Agent host.", goHome: true });
    ws.close();
    return;
  }

  if (!session) {
    const cwd = resolveAgentHostPath(requestedAgentHost, url.searchParams.get("cwd") || ".");
    const launch = await getLaunchConfig(url.searchParams, requestedAgentHost);

    if (!cwd) {
      logWebSocketReject(req, "invalid-cwd");
      send(ws, "error", { message: "Invalid cwd outside workspace root." });
      ws.close();
      return;
    }

    if (!launch) {
      logWebSocketReject(req, "invalid-launch");
      send(ws, "error", { message: "Invalid launch mode or session ID." });
      ws.close();
      return;
    }

    launch.agentHost = requestedAgentHost;
    launch.hostId = requestedAgentHost.id;
    if (requestedAgentHost.type === "ssh" && launch.transport !== APP_SERVER_TRANSPORT) {
      logWebSocketReject(req, "unsupported-remote-transport");
      send(ws, "error", { message: "Remote hosts support App Server sessions only." });
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
  console.log(`Shared App Server: ${SHARED_APP_SERVER_ENABLED ? "enabled" : "disabled"}`);
});

process.once("exit", () => {
  agentHostAppServerPool?.close();
  if (platformKernelPool) for (const kernel of platformKernelPool.values()) kernel.close();
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
  if (session.transport === APP_SERVER_TRANSPORT) query.set("transport", APP_SERVER_TRANSPORT);
  if (session.access === FULL_ACCESS_MODE) query.set("access", FULL_ACCESS_MODE);
  const homeQuery = new URLSearchParams({ focus: "agent" });
  homeQuery.set("sessionId", session.sessionId || session.id);
  if (session.hostId !== PERSONAL_AGENT_HOST.id) {
    query.set("host", session.hostId);
    homeQuery.set("host", session.hostId);
  }

  const response = await fetch(HOME_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      notification: {
        title: `Agent 完成 · ${title}`,
        body: "任务已完成，点开查看结果。",
        url: notificationApp === "home" ? `/?${homeQuery}` : `/?${query}`,
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

async function sendRemoteAgentTurnNotification(agentHost, completion) {
  const query = new URLSearchParams({
    host: agentHost.id,
    sessionId: completion.threadId,
    transport: APP_SERVER_TRANSPORT,
    preview: "1",
  });
  const response = await fetch(HOME_PUSH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "agent-web",
      notification: {
        title: `${agentHost.label} Agent 已完成`,
        body: "任务已完成，点开查看结果。",
        url: `/?${query}`,
        tag: `agent-${agentHost.id}-${completion.threadId}`,
        badge: 0,
      },
      target: { app: "agent" },
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

function applyPublicShareHeaders(res) {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    Pragma: "no-cache",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  });
}

async function pruneExpiredSessionShares() {
  try {
    await sessionShareStore.prune();
  } catch (error) {
    logAgentEvent("session-share-prune-failed", {
      message: cleanClientLogValue(error.message, 300),
    });
  }
}

function requireSafeIntegrationMutation(req, res, next) {
  requireSameOriginMutation(req, res, () => {
    const key = String(req.socket.remoteAddress || "unknown");
    const now = Date.now();
    const recent = (integrationMutationAttempts.get(key) || []).filter(
      (timestamp) => now - timestamp < 10 * 60 * 1000,
    );
    if (recent.length >= 10) {
      res.status(429).json({ error: "集成设置操作过于频繁，请稍后重试。" });
      return;
    }
    recent.push(now);
    integrationMutationAttempts.set(key, recent);
    next();
  });
}

function requireSameOriginMutation(req, res, next) {
  const origin = String(req.get("origin") || "");
  const sameOrigin = origin
    ? origin === getOrigin(req)
    : String(req.get("sec-fetch-site") || "") === "same-origin";
  if (!sameOrigin) {
    res.status(403).json({ error: "无法确认请求来自当前 Agent 页面。" });
    return;
  }
  next();
}

function sendIntegrationError(res, error, fallback) {
  if (error instanceof IntegrationError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  logAgentEvent("integration-mutation-failed", {
    message: cleanClientLogValue(error?.message, 200),
  });
  res.status(500).json({ error: fallback });
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

function cleanClientEventPath(value) {
  const raw = cleanClientLogValue(value, 2_000);
  if (!raw) return "";
  try {
    return cleanClientLogValue(new URL(raw, "https://agent.invalid").pathname, 300);
  } catch {
    return cleanClientLogValue(raw.split(/[?#]/, 1)[0], 300);
  }
}

function codexArgsForWeb(args, personalMemoryContext = "") {
  const notify = JSON.stringify([process.execPath, CODEX_NOTIFY_SCRIPT]);
  const memoryArgs = personalMemoryContext
    ? ["-c", `developer_instructions=${JSON.stringify(personalMemoryContext)}`]
    : [];
  return ["-c", `notify=${notify}`, ...memoryArgs, ...args];
}

function codexEnvironmentForWeb(sessionId, extra = {}) {
  return {
    ...process.env,
    ...extra,
    PATH: [CODEX_GUARD_BIN, process.env.PATH].filter(Boolean).join(path.delimiter),
    AGENT_WEB_SESSION_ID: sessionId,
    AGENT_WEB_PROTECTED_SERVICE: "agent-terminal-web.service",
  };
}

function sharedAgentAppServerPool() {
  if (agentHostAppServerPool) return agentHostAppServerPool;
  agentHostAppServerPool = new AgentHostAppServerPool({
    spawnCwd: WORKSPACE_ROOT,
    localCommand: process.env.CODEX_APP_SERVER_COMMAND || "codex",
    localEnv: codexEnvironmentForWeb(`shared-${agentInstanceId}`),
  });
  return agentHostAppServerPool;
}

function sharedAgentAppServerConnection(agentHost = PERSONAL_AGENT_HOST) {
  const connection = sharedAgentAppServerPool().connectionFor(agentHost);
  if (connection.agentWebEventsBound) return connection;
  connection.agentWebEventsBound = true;
  connection.on("stderr", (text) => {
    logAgentEvent("app-server-stderr", {
      shared: true,
      hostId: agentHost.id,
      message: cleanClientLogValue(text, 500),
    });
  });
  connection.on("protocol-error", (error) => {
    logAgentEvent("app-server-protocol-error", {
      shared: true,
      hostId: agentHost.id,
      message: cleanClientLogValue(error?.message, 500),
    });
  });
  connection.on("exit", (error) => {
    logAgentEvent("shared-app-server-exit", {
      hostId: agentHost.id,
      message: cleanClientLogValue(error?.message, 500),
    });
  });
  return connection;
}

let platformKernelPool = null;

function sharedPlatformKernel(agentHost) {
  platformKernelPool ||= new Map();
  let kernel = platformKernelPool.get(agentHost.id);
  if (!kernel) {
    kernel = platformKernelFor(sharedAgentAppServerConnection(agentHost), {
      bindingStore: jsonFileBindingStore(PLATFORM_BINDINGS_FILE),
      runtimeLeaseMs: SESSION_TTL_MS,
      detachedLeaseMs: SESSION_TTL_MS,
    });
    platformKernelPool.set(agentHost.id, kernel);
  }
  return kernel;
}

function platformKernelEnabledFor(agentHost, restored = {}) {
  if (PLATFORM_KERNEL_FORCE_LEGACY) return false;
  if (!SHARED_APP_SERVER_ENABLED) return false;
  if (!agentHost || agentHost.type === "ssh") return false;
  return (
    restored.runtimeKernel === "platform" ||
    PLATFORM_KERNEL_ALL ||
    (PLATFORM_KERNEL_NEW_SESSIONS && !restored.id)
  );
}

function createAgentAppServerClient(
  cwd,
  webSessionId,
  clientInfo = undefined,
  agentHost = PERSONAL_AGENT_HOST,
  { runtimeKernel = "legacy" } = {},
) {
  if (
    runtimeKernel === "platform" &&
    SHARED_APP_SERVER_ENABLED &&
    agentHost.type !== "ssh"
  ) {
    return new PlatformAppServerClient({
      sessionId: webSessionId,
      cwd,
      connection: sharedAgentAppServerConnection(agentHost),
      kernel: sharedPlatformKernel(agentHost),
    });
  }
  if (SHARED_APP_SERVER_ENABLED) {
    return new CodexAppServerClient({
      cwd,
      connection: sharedAgentAppServerConnection(agentHost),
    });
  }
  if (agentHost.type === "ssh") {
    return new CodexAppServerClient({
      cwd,
      connection: sharedAgentAppServerConnection(agentHost),
    });
  }
  return new CodexAppServerClient({
    cwd,
    command: process.env.CODEX_APP_SERVER_COMMAND || "codex",
    env: codexEnvironmentForWeb(webSessionId),
    ...(clientInfo ? { clientInfo } : {}),
  });
}

function releaseAgentAppServerClient(client, { interrupt = false } = {}) {
  if (!client || client.closed) return;
  if (!SHARED_APP_SERVER_ENABLED || client.ownsConnection) {
    client.close();
    return;
  }

  const threadId = String(client.threadId || "");
  const turnId = String(client.activeTurnId || "");
  void (async () => {
    try {
      if (interrupt && threadId && turnId) {
        await client.request("turn/interrupt", { threadId, turnId });
      }
      if (threadId) {
        await client.request("thread/unsubscribe", { threadId });
      }
    } catch (error) {
      logAgentEvent("shared-app-server-detach-failed", {
        threadId,
        turnId,
        message: cleanClientLogValue(error?.message, 300),
      });
    } finally {
      client.close();
    }
  })();
}

function cleanClientLogValue(value, maxLength) {
  return String(value || "")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, maxLength);
}

function webSocketRequestLogFields(req) {
  let url;
  try {
    url = new URL(req.url || "", `http://${req.headers.host || "localhost"}`);
  } catch {
    url = new URL("http://localhost/");
  }
  const clientId = cleanWebClientId(url.searchParams.get("clientId"));
  return {
    path: cleanClientLogValue(url.pathname, 120),
    webSessionId: cleanClientLogValue(url.searchParams.get("attach"), 100),
    codexSessionId: cleanClientLogValue(url.searchParams.get("sessionId"), 100),
    hostId: cleanClientLogValue(url.searchParams.get("host") || PERSONAL_AGENT_HOST.id, 40),
    clientId: clientId ? shortClientId(clientId) : "",
    proxied: Boolean(req.headers["x-forwarded-for"] || req.headers["x-forwarded-host"]),
    forwardedProto: cleanClientLogValue(req.headers["x-forwarded-proto"], 20),
  };
}

function webSocketElapsedMs(startedAt) {
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : undefined;
}

function logWebSocketReject(req, reason, fields = {}) {
  logAgentEvent("ws-reject", {
    ...(req.agentWebUpgradeLogFields || webSocketRequestLogFields(req)),
    reason,
    durationMs: webSocketElapsedMs(req.agentWebUpgradeStartedAt),
    ...fields,
  });
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
  if (launch.transport === APP_SERVER_TRANSPORT) return createAppServerSession(cwd, launch, restored);
  if (launch.agentHost?.type === "ssh") {
    return { error: "Remote hosts support App Server sessions only." };
  }
  return createTerminalSession(cwd, launch, restored);
}

function createTerminalSession(cwd, launch, restored = {}) {
  const agentHost = launch.agentHost || PERSONAL_AGENT_HOST;
  const id = restored.id || cryptoRandomId();
  const startedAt = new Date().toISOString();
  const shell = process.env.CODEX_COMMAND || "codex";
  const initialMemoryRouting =
    agentHost.type === "local"
      ? initialSessionMemoryRouting(launch.sessionId, restored)
      : { mode: "auto", projects: [], source: "global" };
  const memoryContext = personalMemoryContextForPromptSync(CODEX_HOME, {
    cwd,
    title: launch.title,
    workspaceRoot: WORKSPACE_ROOT,
    memoryProjectMode: initialMemoryRouting.mode,
    memoryProjects: initialMemoryRouting.projects,
    knownProjects: workspaceMemoryProjectNames(),
  });
  const commandArgs = codexArgsForWeb(launch.args, memoryContext.value);
  const env = codexEnvironmentForWeb(id, {
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    AGENT_NOTIFY_URL,
  });
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
    hostId: agentHost.id,
    hostLabel: agentHost.label,
    cwd,
    project: agentHostProject(agentHost, cwd),
    pid: terminal.pid,
    command: shell,
    args: commandArgs,
    transport: "terminal",
    access: normalizeAccessMode(launch.access),
    purpose: normalizeSessionPurpose(launch.purpose || restored.purpose),
    thinkSkillActivated: Boolean(restored.thinkSkillActivated),
    ready: true,
    mode: launch.mode,
    sessionId: launch.sessionId,
    title: launch.title || "",
    memoryProjectMode: memoryContext.projectMode,
    memoryProjects: memoryContext.projects,
    memoryProjectSource: memoryContext.projectSource,
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
    detachedAt: validSessionTimestamp(restored.detachedAt),
    cols: 100,
    rows: 30,
    turnState: restoreTurnState(restored.turnState),
  };
  sessions.set(id, session);
  rememberAgentSessionAccess(session.sessionId, session.access, session.hostId);
  rememberAgentSessionMemoryRouting(session);
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
    appendSessionOutput(session, data);
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

function createAppServerSession(cwd, launch, restored = {}) {
  const id = restored.id || cryptoRandomId();
  const startedAt = new Date().toISOString();
  const agentHost = launch.agentHost || PERSONAL_AGENT_HOST;
  const initialMemoryRouting =
    agentHost.type === "local"
      ? initialSessionMemoryRouting(launch.sessionId, restored)
      : { mode: "auto", projects: [], source: "global" };
  const usePlatformKernel = platformKernelEnabledFor(agentHost, restored);
  const appServer = createAgentAppServerClient(cwd, id, undefined, agentHost, {
    runtimeKernel: usePlatformKernel ? "platform" : "legacy",
  });
  const session = {
    id,
    hostId: agentHost.id,
    hostLabel: agentHost.label,
    cwd,
    project: agentHostProject(agentHost, cwd),
    pid: null,
    command: "codex app-server",
    args: ["app-server"],
    transport: APP_SERVER_TRANSPORT,
    access: normalizeAccessMode(launch.access),
    runtimeKernel: usePlatformKernel ? "platform" : "legacy",
    purpose: normalizeSessionPurpose(launch.purpose || restored.purpose),
    thinkSkillActivated: Boolean(restored.thinkSkillActivated),
    ready: false,
    released: false,
    releaseReason: "",
    mode: launch.mode,
    sessionId: launch.sessionId,
    title: launch.title || "",
    forkedFromId: String(restored.forkedFromId || ""),
    forkedFromTitle: String(restored.forkedFromTitle || ""),
    parentThreadId: String(restored.parentThreadId || ""),
    parentThreadTitle: String(restored.parentThreadTitle || ""),
    memoryProjectMode: initialMemoryRouting.mode,
    memoryProjects: initialMemoryRouting.projects,
    memoryProjectSource: initialMemoryRouting.source,
    tmuxName: "",
    terminal: null,
    appServer,
    interruptedResumePending: false,
    turnInterruptPending: false,
    pendingServerRequests: new Map(),
    pendingStartupPrompts: [],
    pendingPersonalMemoryCitations: [],
    personalMemoryCitationsByTurn: new Map(),
    collabAgentMetadata: new Map(),
    submittedAttachmentMetadata: new Map(),
    streamedItemIds: new Set(),
    lastAssistantMessage: "",
    appTranscript: [],
    appTranscriptSequence: 0,
    restoredTurnCount: 0,
    restoredHistoryHasMore: false,
    restoredHistoryCursor: null,
    restoredHistoryLoading: false,
    sideChat: null,
    realtime: restoreRealtimeState(),
    appSkills: null,
    appTokenUsage: null,
    appModel: String(restored.appModel || ""),
    appReasoningEffort: String(restored.appReasoningEffort || ""),
    appServiceTier: ["priority", "default"].includes(restored.appServiceTier) ? restored.appServiceTier : null,
    orchestrationMode: normalizeOrchestrationMode(restored.orchestrationMode),
    clients: new Set(),
    cleanupTimer: null,
    runtimeLeaseTimer: null,
    lastMeaningfulActivityAt: startedAt,
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
    detachedAt: validSessionTimestamp(restored.detachedAt),
    cols: 100,
    rows: 30,
    turnState: restoreTurnState(restored.turnState),
  };
  sessions.set(id, session);
  persistRestorableWebSession(session);
  wireAppServerSession(session);
  renewAppServerRuntimeLease(session);
  void initializeAppServerSession(session, launch);
  logAgentEvent("session-start", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    mode: session.mode,
    transport: session.transport,
    runtimeKernel: session.runtimeKernel,
    project: session.project,
    restored: Boolean(launch.sessionId),
  });
  return session;
}

function wireAppServerSession(session) {
  session.appServer.on("notification", (message) => handleAppServerNotification(session, message));
  session.appServer.on("server-request", (message) => handleAppServerRequest(session, message));
  session.appServer.on("stderr", (text) => {
    logAgentEvent("app-server-stderr", {
      webSessionId: session.id,
      message: cleanClientLogValue(text, 500),
    });
  });
  session.appServer.on("protocol-error", (error) => appendSessionOutput(session, `\r\nProtocol error: ${error.message}\r\n`));
  session.appServer.on("exit", (error) => markAppServerExited(session, error));
}

async function initializeAppServerSession(session, launch) {
  try {
    const initializationStartedAt = Date.now();
    await session.appServer.start();
    session.pid = session.appServer.child?.pid || null;
    const params = {
      cwd: session.cwd,
      sandbox: session.access === FULL_ACCESS_MODE ? "danger-full-access" : "workspace-write",
      approvalPolicy: session.access === FULL_ACCESS_MODE ? "never" : "on-request",
      developerInstructions: AGENT_WEB_DEVELOPER_INSTRUCTIONS,
    };
    let thread;
    if (launch.sessionId) {
      const resumed = await resumeAppServerThread(session, launch, {
        ...params,
        excludeTurns: true,
        initialTurnsPage: {
          limit: APP_INITIAL_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "full",
        },
      });
      thread = resumed.thread;
      const recentPage = resumed.initialTurnsPage || { data: [], nextCursor: null };
      restoreAppServerTranscript(session, { ...thread, turns: recentPage?.data || [] }, { resumed: true });
      restoreResumedActiveTurnState(session, recentPage?.data || []);
      session.restoredHistoryCursor = recentPage?.nextCursor || null;
      session.restoredHistoryHasMore = Boolean(recentPage?.nextCursor);
      logAgentEvent("app-server-recent-history", {
        webSessionId: session.id,
        codexSessionId: launch.sessionId,
        durationMs: Date.now() - initializationStartedAt,
        restoredTurns: session.restoredTurnCount,
        hasEarlierTurns: session.restoredHistoryHasMore,
      });
    } else {
      thread = await session.appServer.startThread(params);
      restoreAppServerTranscript(session, thread, { resumed: false });
    }
    session.sessionId = thread.id;
    session.forkedFromId = String(thread.forkedFromId || session.forkedFromId || "");
    session.parentThreadId = String(thread.parentThreadId || session.parentThreadId || "");
    if (session.parentThreadId) {
      const parent = await session.appServer
        .readThread({ threadId: session.parentThreadId, includeTurns: false })
        .catch(() => null);
      session.parentThreadTitle =
        cleanCustomTitle(parent?.name) ||
        cleanTitle(parent?.preview) ||
        session.parentThreadTitle ||
        "主 Agent";
    }
    rememberAgentSessionAccess(session.sessionId, session.access, session.hostId);
    rememberAgentSessionRelation(session.sessionId, {
      forkedFromId: session.forkedFromId,
      forkedFromTitle: session.forkedFromTitle,
      parentThreadId: session.parentThreadId,
      parentThreadTitle: session.parentThreadTitle,
    }, session.hostId);
    rememberAgentSessionMemoryRouting(session);
    session.ready = true;
    session.released = false;
    session.releaseReason = "";
    appendSessionOutput(session, "\r\n\x1b[36mApp Server ready. Follow-ups are bound to an exact turn.\x1b[0m\r\n");
    persistRestorableWebSession(session);
    broadcast(session, "app-transcript", publicAppTranscript(session));
    broadcast(session, "status", publicSession(session));
    scheduleSessionProcessIndexWarm(session);
    void drainAppServerStartupPrompts(session);
  } catch (error) {
    appendSessionOutput(session, `\r\n\x1b[31mApp Server failed to start: ${error.message}\x1b[0m\r\n`);
    if (session.pendingStartupPrompts.length) {
      broadcast(session, "error", {
        message: `App Server failed to start: ${error.message}`,
        preservePrompt: true,
      });
    }
    markAppServerExited(session, error);
    releaseAgentAppServerClient(session.appServer);
  }
}

async function resumeAppServerThread(session, launch, params) {
  const threadId = launch.sessionId;
  let unarchived = false;

  const unarchive = async () => {
    if (unarchived) return;
    await session.appServer.setThreadArchived(false, threadId);
    unarchived = true;
    if (launch.agentHost?.type !== "local") return;
    const archive = await readSessionArchive();
    if (!archive[threadId]) return;
    delete archive[threadId];
    await writeSessionArchive(archive);
  };

  if (launch.agentHost?.type === "local") {
    const archive = await readSessionArchive();
    if (archive[threadId]) await unarchive();
  }

  try {
    return await session.appServer.resumeThreadWithResult(threadId, params);
  } catch (error) {
    if (!/\bis archived\b/i.test(String(error?.message || ""))) throw error;
    await unarchive();
    return session.appServer.resumeThreadWithResult(threadId, params);
  }
}

function findReusableSession(launch) {
  if (!launch.sessionId) return null;

  return (
    [...sessions.values()]
      .filter((session) => !session.exited && session.sessionId === launch.sessionId)
      .filter((session) => session.transport === (launch.transport || "terminal"))
      .filter((session) => session.hostId === (launch.hostId || PERSONAL_AGENT_HOST.id))
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
  if (
    record.transport !== APP_SERVER_TRANSPORT &&
    !record.released &&
    persistedSessionExpired(record)
  ) {
    removePersistedWebSession(id);
    return null;
  }

  const agentHost = resolveAgentHost(AGENT_HOSTS, record.hostId);
  if (!agentHost) {
    return { error: "This web session belongs to an unavailable Agent host." };
  }
  const cwd = resolveAgentHostPath(agentHost, record.cwd);
  if (!cwd) {
    removePersistedWebSession(id);
    return { error: "This web session has an invalid directory. Returning to Agent home." };
  }

  if (record.transport === APP_SERVER_TRANSPORT) {
    if (!record.sessionId) return null;
    const reusable = findReusableSession({
      sessionId: record.sessionId,
      transport: APP_SERVER_TRANSPORT,
      hostId: agentHost.id,
    });
    if (reusable) return reusable;
    return createSession(
      cwd,
      {
        mode: "resume-id",
        transport: APP_SERVER_TRANSPORT,
        access: normalizeAccessMode(record.access),
        sessionId: record.sessionId,
        args: ["app-server"],
        title: record.title || "",
        purpose: normalizeSessionPurpose(record.purpose),
        agentHost,
        hostId: agentHost.id,
      },
      {
        id,
        startedAt: record.startedAt,
        lastActivityAt: record.lastActivityAt,
        detachedAt: detachedAtForRecord(record),
        notificationApp: record.notificationApp,
        notificationDeviceId: record.notificationDeviceId,
        purpose: normalizeSessionPurpose(record.purpose),
        thinkSkillActivated: Boolean(record.thinkSkillActivated),
        appModel: record.appModel,
        appReasoningEffort: record.appReasoningEffort,
        appServiceTier: record.appServiceTier,
        orchestrationMode: record.orchestrationMode,
        memoryProjectMode: record.memoryProjectMode,
        memoryProjects: record.memoryProjects,
        memoryProjectSource: record.memoryProjectSource,
        runtimeKernel: record.runtimeKernel,
        turnState: interruptedTurnStateAfterProcessLoss(record.turnState, record.lastActivityAt),
      },
    );
  }

  if (!USE_TMUX_SESSIONS) {
    if (!record.sessionId) return null;
    const reusable = findReusableSession({
      sessionId: record.sessionId,
      transport: APP_SERVER_TRANSPORT,
      hostId: agentHost.id,
    });
    if (reusable) return reusable;

    return createSession(
      cwd,
      {
        mode: "resume-id",
        transport: APP_SERVER_TRANSPORT,
        access: normalizeAccessMode(record.access),
        sessionId: record.sessionId,
        args: ["app-server"],
        title: record.title || "",
        purpose: normalizeSessionPurpose(record.purpose),
        agentHost,
        hostId: agentHost.id,
      },
      {
        id,
        startedAt: record.startedAt,
        lastActivityAt: record.lastActivityAt,
        detachedAt: detachedAtForRecord(record),
        notificationApp: record.notificationApp,
        notificationDeviceId: record.notificationDeviceId,
        purpose: normalizeSessionPurpose(record.purpose),
        thinkSkillActivated: Boolean(record.thinkSkillActivated),
        appModel: record.appModel,
        appReasoningEffort: record.appReasoningEffort,
        appServiceTier: record.appServiceTier,
        orchestrationMode: record.orchestrationMode,
        memoryProjectMode: record.memoryProjectMode,
        memoryProjects: record.memoryProjects,
        memoryProjectSource: record.memoryProjectSource,
        runtimeKernel: record.runtimeKernel,
        turnState: interruptedTurnStateAfterProcessLoss(record.turnState, record.lastActivityAt),
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
    access: normalizeAccessMode(record.access),
    sessionId: record.sessionId || "",
    args: Array.isArray(record.args) && record.args.length ? record.args : ["--no-alt-screen"],
    title: record.title || "",
    purpose: normalizeSessionPurpose(record.purpose),
    agentHost,
    hostId: agentHost.id,
  };

  return createSession(cwd, launch, {
    id,
    tmuxName,
    attachExistingTmux: true,
    startedAt: record.startedAt,
    lastActivityAt: record.lastActivityAt,
    detachedAt: detachedAtForRecord(record),
    notificationApp: record.notificationApp,
    notificationDeviceId: record.notificationDeviceId,
    purpose: normalizeSessionPurpose(record.purpose),
    thinkSkillActivated: Boolean(record.thinkSkillActivated),
    memoryProjectMode: record.memoryProjectMode,
    memoryProjects: record.memoryProjects,
    memoryProjectSource: record.memoryProjectSource,
    turnState: record.turnState,
  });
}

function listDetachedSessions() {
  const records = readPersistedWebSessions();
  const archivedPersonalSessionIds = new Set(Object.keys(readSessionArchiveSync()));
  const items = [];
  let recordsChanged = false;

  for (const [id, record] of Object.entries(records)) {
    if (sessions.has(id) || !isValidWebSessionId(id)) continue;
    const transport = record.transport === APP_SERVER_TRANSPORT ? APP_SERVER_TRANSPORT : "terminal";
    const explicitlyReleased =
      transport === APP_SERVER_TRANSPORT
        ? record.released === true &&
          [APP_SERVER_RELEASE_REASON_DETACHED_TTL, APP_SERVER_RELEASE_REASON_IDLE_TTL].includes(record.releaseReason)
        : Boolean(record.released);
    // Older builds rewrote every App Server record as released during boot.
    // Only a reason-tagged release was an intentional runtime pause.
    if (transport === APP_SERVER_TRANSPORT && record.released && !explicitlyReleased) {
      record.released = false;
      delete record.releaseReason;
      recordsChanged = true;
    }
    if (transport !== APP_SERVER_TRANSPORT && !record.released && persistedSessionExpired(record)) {
      delete records[id];
      recordsChanged = true;
      continue;
    }
    const tmuxName = cleanTmuxName(record.tmuxName || tmuxNameForWebSession(id));
    if (transport === "terminal" && (!USE_TMUX_SESSIONS || !tmuxName || !tmuxHasSession(tmuxName))) continue;
    if (transport === APP_SERVER_TRANSPORT && !record.sessionId) continue;

    const agentHost = resolveAgentHost(AGENT_HOSTS, record.hostId);
    const cwd = agentHost ? resolveAgentHostPath(agentHost, record.cwd) : null;
    if (!cwd) continue;
    if (
      agentHost.id === PERSONAL_AGENT_HOST.id &&
      archivedPersonalSessionIds.has(String(record.sessionId || ""))
    ) {
      continue;
    }
    const resultState = agentSessionResultState(
      record.sessionId,
      record.turnState?.lastCompletedTurnId,
      null,
      agentHost.id,
    );
    const turnState =
      transport === APP_SERVER_TRANSPORT && !explicitlyReleased
        ? interruptedTurnStateAfterProcessLoss(record.turnState, record.lastActivityAt)
        : restoreTurnState(record.turnState);

    items.push({
      id,
      hostId: agentHost.id,
      hostLabel: agentHost.label,
      cwd,
      project: agentHostProject(agentHost, cwd),
      title: record.title || "New Codex session",
      pid: null,
      command: record.command || "codex",
      args: Array.isArray(record.args) ? record.args : [],
      transport,
      access: normalizeAccessMode(record.access),
      purpose: normalizeSessionPurpose(record.purpose),
      ready: transport === APP_SERVER_TRANSPORT && !explicitlyReleased,
      suspended: transport === APP_SERVER_TRANSPORT,
      mode: record.mode || "new",
      sessionId: record.sessionId || "",
      orchestrationMode: normalizeOrchestrationMode(record.orchestrationMode),
      memoryProjectMode: record.memoryProjectMode === "manual" ? "manual" : "auto",
      memoryProjects: normalizeMemoryProjectNames(record.memoryProjects),
      memoryProjectSource: normalizeMemoryProjectSource(record.memoryProjectSource),
      startedAt: record.startedAt || new Date().toISOString(),
      lastActivityAt: record.lastActivityAt || record.startedAt || new Date().toISOString(),
      detachedAt: detachedAtForRecord(record),
      cols: 100,
      rows: 30,
      connectedClients: 0,
      detachedExpiresAt: detachedExpiresAt(record),
      released: explicitlyReleased,
      exited: false,
      exitCode: null,
      signal: null,
      turnState: publicTurnState(turnState),
      ...resultState,
    });
  }

  if (recordsChanged) writePersistedWebSessions(records);
  return items;
}

function attachClient(session, ws, { replay = true, afterRevision = null, clientId = "" } = {}) {
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }

  ws.webSessionId = session.id;
  ws.codexSessionId = session.sessionId;
  ws.agentWebAttachedAt = Date.now();
  const heartbeatTimer = startWebSocketHeartbeat(ws, session);
  ws.clientId = clientId;
  closeDuplicateClient(session, ws);
  session.clients.add(ws);
  if (session.transport === APP_SERVER_TRANSPORT) {
    session.detachedAt = null;
    persistRestorableWebSession(session);
  }
  queueSessionControlEvent(session);
  logAgentEvent("ws-attach", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    clients: session.clients.size,
    clientId: clientId ? shortClientId(clientId) : "",
    upgradeDurationMs: webSocketElapsedMs(ws.agentWebUpgradeStartedAt),
  });
  send(ws, "status", publicSession(session));
  if (session.transport === APP_SERVER_TRANSPORT) {
    send(ws, "app-transcript", publicAppTranscript(session));
    send(ws, "side-chat-state", publicSideChatState(session.sideChat));
    send(ws, "realtime-state", publicRealtimeState(session.realtime));
    for (const request of session.pendingServerRequests.values()) {
      send(ws, "agent-request", publicAppServerRequest(request));
    }
  }
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
      if (session.transport === APP_SERVER_TRANSPORT) {
        send(ws, "error", { message: "Raw terminal keys are unavailable in App Server mode." });
        return;
      }
      rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
      renewSessionRetention(session);
      logControlMessage(session, ws, "input", message.data);
      session.terminal.write(message.data);
      session.lastActivityAt = new Date().toISOString();
      persistRestorableWebSession(session);
      send(ws, "control-ack", { kind: "input", receivedAt: Date.now() });
      return;
    }

    if (message.type === "submit" && typeof message.data === "string") {
      if (session.transport === APP_SERVER_TRANSPORT && realtimeBusy(session.realtime)) {
        send(ws, "error", { message: "实时语音正在使用当前 Session，请先结束语音对话。", preservePrompt: true });
        return;
      }
      const normalized = message.data.trim();
      let attachments;
      try {
        attachments = normalizeSubmittedAttachments(message.attachments);
      } catch (error) {
        send(ws, "error", { message: error.message, preservePrompt: true });
        return;
      }
      if (normalized || attachments.length) {
        const requirementText = normalized || attachmentRequirementText(attachments);
        rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
        renewSessionRetention(session);
        logControlMessage(session, ws, "submit", requirementText, {
          attachmentCount: attachments.length,
          attachmentBytes: attachments.reduce((total, attachment) => total + attachment.size, 0),
        });
        if (!session.title) session.title = cleanTitle(requirementText) || "New Codex session";
        const prompt = prepareSessionPrompt(session, normalized);
        const skillNames = requestedAppSkillNames(prompt.text, message.skills);
        if (prompt.activatesThink) session.thinkSkillActivationPending = true;
        if (session.transport === APP_SERVER_TRANSPORT) {
          rememberSubmittedAttachments(session, attachments);
          if (!session.ready) {
            session.pendingStartupPrompts.push({
              text: prompt.text,
              requirementText,
              attachments,
              deliveryMode: message.deliveryMode,
              activatesThink: prompt.activatesThink,
              skillNames,
            });
            send(ws, "control-ack", {
              kind: "submit",
              receivedAt: Date.now(),
              deliveryMode: "startup-queue",
              turnState: publicTurnState(session.turnState),
            });
            return;
          }
          void submitAppServerPrompt(session, prompt.text, message.deliveryMode, skillNames, attachments, requirementText)
            .then((submission) => {
              if (prompt.activatesThink) {
                session.thinkSkillActivated = true;
                session.thinkSkillActivationPending = false;
              }
              session.lastActivityAt = new Date().toISOString();
              persistRestorableWebSession(session);
              broadcast(session, "status", publicSession(session));
              send(ws, "control-ack", {
                kind: "submit",
                receivedAt: Date.now(),
                deliveryMode: submission.deliveryMode,
                skills: submission.skills,
                turnState: publicTurnState(session.turnState),
              });
            })
            .catch((error) => {
              if (prompt.activatesThink) session.thinkSkillActivationPending = false;
              send(ws, "error", { message: `Prompt was not sent: ${error.message}`, preservePrompt: true });
            });
          return;
        }
        const submission = submitTrackedPrompt(
          session,
          terminalPromptWithAttachments(prompt.text, attachments),
          message.deliveryMode,
          requirementText,
        );
        if (prompt.activatesThink) {
          session.thinkSkillActivated = true;
          session.thinkSkillActivationPending = false;
        }
        session.lastActivityAt = new Date().toISOString();
        persistRestorableWebSession(session);
        broadcast(session, "status", publicSession(session));
        send(ws, "control-ack", {
          kind: "submit",
          receivedAt: Date.now(),
          deliveryMode: submission.deliveryMode,
          skills: submission.skills,
          turnState: publicTurnState(session.turnState),
        });
      }
      return;
    }

    if (message.type === "load-app-history" && session.transport === APP_SERVER_TRANSPORT) {
      void loadEarlierAppServerHistory(session).catch((error) => {
        send(ws, "error", { message: `Earlier history was not loaded: ${error.message}` });
      });
      return;
    }

    if (message.type === "edit-and-fork" && session.transport === APP_SERVER_TRANSPORT) {
      if (session.turnState.active || session.appServer.activeTurnId) {
        send(ws, "error", { message: "当前任务仍在处理，完成后才能编辑历史消息并分支。", preservePrompt: true });
        return;
      }
      const editedText = String(message.data || "").trim();
      const beforeTurnId = String(message.turnId || "");
      const sourceItem = session.appTranscript.find(
        (item) => item.type === "user" && item.turnId === beforeTurnId && item.id === String(message.itemId || ""),
      );
      if (!sourceItem || !isCodexTurnId(beforeTurnId)) {
        send(ws, "error", { message: "找不到要编辑的历史消息，请刷新后重试。", preservePrompt: true });
        return;
      }
      let attachments;
      try {
        attachments = normalizeEditForkAttachments(message.attachments, sourceItem);
      } catch (error) {
        send(ws, "error", { message: error.message, preservePrompt: true });
        return;
      }
      if (!editedText && !attachments.length) {
        send(ws, "error", { message: "编辑后的消息不能为空。", preservePrompt: true });
        return;
      }

      rememberNotificationTarget(session, message.notificationApp, message.notificationDeviceId);
      renewSessionRetention(session);
      rememberSubmittedAttachments(session, attachments);
      void editAndForkAppServerSession(session, {
        beforeTurnId,
        editedText,
        attachments,
        sourceTitle: session.title,
      })
        .then((result) => {
          send(ws, "control-ack", {
            kind: "edit-and-fork",
            receivedAt: Date.now(),
            ...result,
            turnState: publicTurnState(session.turnState),
          });
        })
        .catch((error) => {
          send(ws, "error", {
            message: error.branchCreated
              ? `编辑分支已在 Codex 中创建，但当前窗口切换或消息提交失败：${error.message}`
              : `编辑分支没有创建：${error.message}`,
            preservePrompt: true,
            branchCreated: Boolean(error.branchCreated),
            sessionId: error.branchCreated ? String(error.forkedThreadId || session.sessionId || "") : "",
            title: error.branchCreated ? session.title : "",
          });
        });
      return;
    }

    if (message.type === "subagents-list" && session.transport === APP_SERVER_TRANSPORT) {
      void sendAppServerSubagents(session, ws).catch((error) => {
        send(ws, "error", { message: `子 Agent 列表暂时不可用：${error.message}` });
      });
      return;
    }

    if (message.type === "subagent-stop" && session.transport === APP_SERVER_TRANSPORT) {
      void stopAppServerSubagent(session, String(message.threadId || ""))
        .then((result) => {
          send(ws, "control-ack", { kind: "subagent-stop", receivedAt: Date.now(), ...result });
          return sendAppServerSubagents(session, ws);
        })
        .catch((error) => send(ws, "error", { message: `子 Agent 没有停止：${error.message}` }));
      return;
    }

    if (message.type === "session-tree" && session.transport === APP_SERVER_TRANSPORT) {
      void sendAppServerThreadTree(session, ws).catch((error) => {
        send(ws, "error", { message: `Session 关系图暂时不可用：${error.message}` });
      });
      return;
    }

    if (message.type === "side-chat-open" && session.transport === APP_SERVER_TRANSPORT) {
      send(ws, "side-chat-state", publicSideChatState(session.sideChat));
      return;
    }

    if (message.type === "side-chat-submit" && session.transport === APP_SERVER_TRANSPORT) {
      const text = String(message.data || "").trim();
      if (!text) {
        send(ws, "error", { message: "临时侧问不能为空。" });
        return;
      }
      renewSessionRetention(session);
      void submitSideChatPrompt(session, text)
        .then((result) => send(ws, "control-ack", { kind: "side-chat-submit", receivedAt: Date.now(), ...result }))
        .catch((error) => send(ws, "side-chat-error", { message: `临时侧问失败：${error.message}` }));
      return;
    }

    if (message.type === "side-chat-stop" && session.transport === APP_SERVER_TRANSPORT) {
      void stopSideChat(session)
        .then(() => send(ws, "control-ack", { kind: "side-chat-stop", receivedAt: Date.now() }))
        .catch((error) => send(ws, "side-chat-error", { message: `临时侧问没有停止：${error.message}` }));
      return;
    }

    if (message.type === "side-chat-close" && session.transport === APP_SERVER_TRANSPORT) {
      closeSideChat(session);
      send(ws, "control-ack", { kind: "side-chat-close", receivedAt: Date.now() });
      return;
    }

    if (message.type === "realtime-voices" && session.transport === APP_SERVER_TRANSPORT) {
      void sendRealtimeVoices(session, ws).catch((error) => {
        send(ws, "realtime-error", { message: `实时语音列表不可用：${error.message}` });
      });
      return;
    }

    if (message.type === "realtime-start" && session.transport === APP_SERVER_TRANSPORT) {
      renewSessionRetention(session);
      void startRealtimeConversation(session, { voice: message.voice, transport: message.transport })
        .then(() => send(ws, "control-ack", { kind: "realtime-start", receivedAt: Date.now() }))
        .catch((error) => failRealtimeConversation(session, error));
      return;
    }

    if (message.type === "realtime-audio" && session.transport === APP_SERVER_TRANSPORT) {
      try {
        if (session.realtime?.status !== "live") throw new Error("实时对话还没有进入连接状态。");
        const audio = normalizeRealtimeAudioChunk(message.audio);
        void session.appServer.appendRealtimeAudio(audio).catch((error) => failRealtimeConversation(session, error));
      } catch (error) {
        failRealtimeConversation(session, error);
      }
      return;
    }

    if (message.type === "realtime-stop" && session.transport === APP_SERVER_TRANSPORT) {
      void stopRealtimeConversation(session)
        .then(() => send(ws, "control-ack", { kind: "realtime-stop", receivedAt: Date.now() }))
        .catch((error) => failRealtimeConversation(session, error));
      return;
    }

    if (message.type === "resume-interrupted" && session.transport === APP_SERVER_TRANSPORT) {
      if (session.interruptedResumePending) {
        send(ws, "error", { message: "The interrupted turn is already being continued." });
        return;
      }
      if (!session.turnState.interrupted || session.turnState.active) {
        send(ws, "error", { message: "This session no longer has an interrupted turn to continue." });
        return;
      }
      const continuation = interruptedContinuationPrompt(session.turnState);
      renewSessionRetention(session);
      session.interruptedResumePending = true;
      void submitAppServerPrompt(session, continuation, "auto")
        .then((submission) => {
          session.lastActivityAt = new Date().toISOString();
          persistRestorableWebSession(session);
          broadcast(session, "status", publicSession(session));
          send(ws, "control-ack", {
            kind: "resume-interrupted",
            receivedAt: Date.now(),
            deliveryMode: submission.deliveryMode,
            turnState: publicTurnState(session.turnState),
          });
        })
        .catch((error) => {
          send(ws, "error", { message: `Interrupted turn was not continued: ${error.message}` });
        })
        .finally(() => {
          session.interruptedResumePending = false;
        });
      return;
    }

    if (message.type === "interrupt-turn" && session.transport === APP_SERVER_TRANSPORT) {
      if (session.turnInterruptPending || session.turnState.stopping) {
        send(ws, "control-ack", { kind: "interrupt-turn", receivedAt: Date.now() });
        return;
      }
      const turnId = session.appServer.activeTurnId || session.turnState.turnId;
      if (!session.turnState.active || !turnId) {
        send(ws, "error", { message: "There is no active task to interrupt." });
        return;
      }
      session.turnInterruptPending = true;
      session.turnState.stopping = true;
      renewSessionRetention(session);
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      void session.appServer
        .interruptTurn()
        .then(() => {
          send(ws, "control-ack", { kind: "interrupt-turn", receivedAt: Date.now(), turnId });
        })
        .catch((error) => {
          session.turnInterruptPending = false;
          session.turnState.stopping = false;
          persistRestorableWebSession(session);
          broadcast(session, "status", publicSession(session));
          send(ws, "error", { message: `Current task was not interrupted: ${error.message}` });
        });
      return;
    }

    if (message.type === "skills-list" && session.transport === APP_SERVER_TRANSPORT) {
      void sendAppServerSkills(session, ws, { forceReload: Boolean(message.forceReload) }).catch((error) => {
        send(ws, "error", { message: `Skills were not loaded: ${error.message}` });
      });
      return;
    }

    if (message.type === "set-access" && session.transport === APP_SERVER_TRANSPORT) {
      renewSessionRetention(session);
      session.access = normalizeAccessMode(message.access);
      rememberAgentSessionAccess(session.sessionId, session.access, session.hostId);
      session.lastActivityAt = new Date().toISOString();
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      send(ws, "control-ack", {
        kind: "access",
        access: session.access,
        receivedAt: Date.now(),
      });
      return;
    }

    if (message.type === "set-memory-projects" && session.transport === APP_SERVER_TRANSPORT) {
      renewSessionRetention(session);
      void updateSessionMemoryRouting(session, {
        mode: message.mode,
        projects: message.projects,
      })
        .then(() => {
          session.lastActivityAt = new Date().toISOString();
          persistRestorableWebSession(session);
          broadcast(session, "status", publicSession(session));
          send(ws, "control-ack", {
            kind: "memory-projects",
            mode: session.memoryProjectMode,
            projects: session.memoryProjects,
            receivedAt: Date.now(),
          });
        })
        .catch((error) => send(ws, "error", { message: `记忆项目没有修改：${error.message}` }));
      return;
    }

    if (message.type === "set-orchestration-mode" && session.transport === APP_SERVER_TRANSPORT) {
      renewSessionRetention(session);
      session.orchestrationMode = normalizeOrchestrationMode(message.mode);
      session.lastActivityAt = new Date().toISOString();
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      send(ws, "control-ack", {
        kind: "orchestration-mode",
        mode: session.orchestrationMode,
        receivedAt: Date.now(),
      });
      return;
    }

    if (message.type === "command" && typeof message.data === "string") {
      renewSessionRetention(session);
      if (session.transport === APP_SERVER_TRANSPORT) {
        void handleAppServerCommand(session, ws, message.data).catch((error) => {
          send(ws, "error", { message: `Command failed: ${error.message}` });
        });
        return;
      }
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
      if (session.transport === "terminal") session.terminal.resize(cols, rows);
      session.cols = cols;
      session.rows = rows;
      broadcast(session, "status", publicSession(session));
      return;
    }

    if (message.type === "agent-response" && session.transport === APP_SERVER_TRANSPORT) {
      try {
        renewSessionRetention(session);
        handleAppServerResponse(session, message);
        send(ws, "control-ack", { kind: "agent-response", receivedAt: Date.now() });
      } catch (error) {
        send(ws, "error", { message: error.message });
      }
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
    queueSessionControlEvent(session);
    logAgentEvent("ws-close", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      code,
      reason: reason?.toString() || "",
      clients: session.clients.size,
      exited: session.exited,
      connectedDurationMs: webSocketElapsedMs(ws.agentWebAttachedAt),
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
      durationMs: webSocketElapsedMs(ws.agentWebUpgradeStartedAt),
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

function logControlMessage(session, ws, kind, data, fields = {}) {
  logAgentEvent("client-control", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    clientId: ws.clientId ? shortClientId(ws.clientId) : "",
    kind,
    dataBytes: Buffer.byteLength(String(data || ""), "utf8"),
    clients: session.clients.size,
    ...fields,
  });
}

function scheduleCleanup(session) {
  if (session.transport === APP_SERVER_TRANSPORT) {
    if (session.exited) {
      sessions.delete(session.id);
      return;
    }
    if (!session.detachedAt) session.detachedAt = new Date().toISOString();
    persistRestorableWebSession(session);
    scheduleAppServerRuntimeLease(session);
    return;
  }
  if (session.cleanupTimer) return;
  if (!session.detachedAt) session.detachedAt = new Date().toISOString();
  if (!session.exited) persistRestorableWebSession(session);
  const expiresAt = detachedExpiresAt(session);
  const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now());
  logAgentEvent("cleanup-scheduled", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    ttlMs: SESSION_TTL_MS,
    detachedAt: session.detachedAt,
    expiresAt,
  });
  session.cleanupTimer = setTimeout(() => {
    session.cleanupTimer = null;
    let runtimeReleased = false;
    if (session.clients.size > 0) {
      renewSessionRetention(session);
      logAgentEvent("cleanup-cancelled", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        reason: "client-reconnected",
      });
      return;
    }
    if (!session.exited && sessionHasActiveWork(session)) {
      session.detachedAt = null;
      persistRestorableWebSession(session);
      logAgentEvent("cleanup-deferred", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        reason: "active-work",
      });
      return;
    }
    if (!session.exited) {
      const releasesAppRuntime = session.transport === APP_SERVER_TRANSPORT && session.sessionId;
      logAgentEvent(releasesAppRuntime ? "session-runtime-release" : "terminal-kill", {
        webSessionId: session.id,
        codexSessionId: session.sessionId,
        reason: "detached-ttl",
      });
      if (releasesAppRuntime) {
        releaseAppServerSessionRuntime(session);
        runtimeReleased = true;
      } else {
        killSessionTerminal(session);
      }
    }
    sessions.delete(session.id);
    if (!runtimeReleased) removePersistedWebSession(session.id);
    logAgentEvent("session-cleanup", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      runtimeReleased,
    });
  }, delayMs);
}

function renewSessionRetention(session) {
  session.detachedAt = null;
  if (session.cleanupTimer) {
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
  }
  renewAppServerRuntimeLease(session);
}

function renewAppServerRuntimeLease(session) {
  if (session?.transport !== APP_SERVER_TRANSPORT || session.exited || session.released) return;
  session.appServer?.renewRuntimeLease?.();
  session.lastMeaningfulActivityAt = new Date().toISOString();
  scheduleAppServerRuntimeLease(session, { reset: true });
}

function scheduleAppServerRuntimeLease(session, { reset = false } = {}) {
  if (session?.transport !== APP_SERVER_TRANSPORT || session.exited || session.released) return;
  if (session.runtimeLeaseTimer && !reset) return;
  if (session.runtimeLeaseTimer) clearTimeout(session.runtimeLeaseTimer);
  const lastMeaningfulAt =
    validSessionTimestamp(session.lastMeaningfulActivityAt) || new Date().toISOString();
  const expiresAt = new Date(Date.parse(lastMeaningfulAt) + SESSION_TTL_MS).toISOString();
  const delayMs = Math.max(0, Date.parse(expiresAt) - Date.now());
  session.runtimeLeaseTimer = setTimeout(() => expireAppServerRuntimeLease(session), delayMs);
  session.runtimeLeaseTimer.unref?.();
}

function expireAppServerRuntimeLease(session) {
  session.runtimeLeaseTimer = null;
  if (session.exited || session.released) return;
  const lastMeaningfulAt =
    validSessionTimestamp(session.lastMeaningfulActivityAt) || new Date().toISOString();
  const remainingMs = Date.parse(lastMeaningfulAt) + SESSION_TTL_MS - Date.now();
  if (remainingMs > 0) {
    scheduleAppServerRuntimeLease(session);
    return;
  }
  if (sessionHasActiveWork(session)) {
    const activeRecheckMs = Math.min(60_000, Math.max(100, Math.floor(SESSION_TTL_MS / 4)));
    session.runtimeLeaseTimer = setTimeout(() => expireAppServerRuntimeLease(session), activeRecheckMs);
    session.runtimeLeaseTimer.unref?.();
    logAgentEvent("runtime-release-deferred", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      reason: "active-work",
    });
    return;
  }
  logAgentEvent("session-runtime-release", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    reason: APP_SERVER_RELEASE_REASON_IDLE_TTL,
    connectedClients: session.clients.size,
  });
  releaseAppServerSessionRuntime(session, { reason: APP_SERVER_RELEASE_REASON_IDLE_TTL });
  sessions.delete(session.id);
}

function sessionHasActiveWork(session) {
  return Boolean(
    session?.turnState?.active ||
      session?.appServer?.activeTurnId ||
      session?.pendingStartupPrompts?.length ||
      session?.pendingServerRequests?.size ||
      session?.sideChat?.active ||
      realtimeBusy(session?.realtime),
  );
}

function resetDetachedCleanupAfterWork(session) {
  if (session.clients.size > 0 || session.exited || sessionHasActiveWork(session)) return;
  renewSessionRetention(session);
  scheduleCleanup(session);
}

function validSessionTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : null;
}

function detachedAtForRecord(record) {
  return (
    validSessionTimestamp(record?.detachedAt) ||
    validSessionTimestamp(record?.lastActivityAt) ||
    validSessionTimestamp(record?.startedAt)
  );
}

function detachedExpiresAt(record) {
  const detachedAt = detachedAtForRecord(record);
  return detachedAt ? new Date(Date.parse(detachedAt) + SESSION_TTL_MS).toISOString() : null;
}

function persistedSessionExpired(record, now = Date.now()) {
  if (record?.turnState?.active) return false;
  const expiresAt = detachedExpiresAt(record);
  return expiresAt ? Date.parse(expiresAt) <= now : true;
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
      logAgentEvent("upload-complete", {
        fileCount: savedFiles.length,
        totalBytes: savedFiles.reduce((total, file) => total + file.size, 0),
      });
      res.json({ files: savedFiles });
    } catch (error) {
      await fail(400, `Upload failed: ${error.message}`);
    }
  });

  req.pipe(form);
}

function normalizeSubmittedAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("附件信息无效，请重新上传。");
  if (value.length > MAX_UPLOAD_FILES) throw new Error(`最多同时发送 ${MAX_UPLOAD_FILES} 个附件。`);

  let uploadsRoot;
  try {
    uploadsRoot = fsSync.realpathSync(UPLOADS_ROOT);
  } catch {
    throw new Error("附件目录暂时不可用，请重新上传。");
  }

  return value.map((attachment) => {
    const submittedPath = String(attachment?.path || "").trim();
    if (!submittedPath || !path.isAbsolute(submittedPath) || !isPathInside(UPLOADS_ROOT, submittedPath)) {
      throw new Error("附件路径无效，请重新上传。");
    }

    let filePath;
    let stat;
    try {
      filePath = fsSync.realpathSync(submittedPath);
      stat = fsSync.statSync(filePath);
    } catch {
      throw new Error("附件已经不存在，请重新上传。");
    }
    if (!isPathInside(uploadsRoot, filePath) || !stat.isFile()) {
      throw new Error("附件路径无效，请重新上传。");
    }
    if (stat.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`每个附件不能超过 ${formatBytes(MAX_UPLOAD_FILE_BYTES)}。`);
    }

    return {
      path: filePath,
      originalName: cleanUploadOriginalName(attachment?.originalName || attachment?.storedName || path.basename(filePath)),
      storedName: path.basename(filePath),
      size: stat.size,
      mime: cleanAttachmentMime(attachment?.mime),
    };
  });
}

function normalizeEditForkAttachments(value, sourceItem) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("附件信息无效，请重新上传。");
  if (value.length > MAX_UPLOAD_FILES) throw new Error(`最多同时发送 ${MAX_UPLOAD_FILES} 个附件。`);

  const historicalByPath = new Map(
    normalizeTranscriptAttachments(sourceItem?.attachments).map((attachment) => [attachment.path, attachment]),
  );
  return value.map((attachment) => {
    const submittedPath = String(attachment?.path || "").trim();
    const historical = historicalByPath.get(submittedPath);
    if (!historical) return normalizeSubmittedAttachments([attachment])[0];

    let filePath;
    let stat;
    try {
      filePath = fsSync.realpathSync(historical.path);
      stat = fsSync.statSync(filePath);
    } catch {
      throw new Error(`历史附件“${historical.originalName}”已经不存在，请重新上传。`);
    }
    if (!stat.isFile() || stat.size > MAX_UPLOAD_FILE_BYTES) {
      throw new Error(`历史附件“${historical.originalName}”无法继续使用，请重新上传。`);
    }
    return {
      path: filePath,
      originalName: historical.originalName,
      storedName: path.basename(filePath),
      size: stat.size,
      mime: /^(?:audio|image)\/\*$/.test(historical.mime)
        ? historical.mime
        : cleanAttachmentMime(historical.mime),
    };
  });
}

function cleanAttachmentMime(value) {
  const mime = String(value || "application/octet-stream")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mime) ? mime : "application/octet-stream";
}

function attachmentRequirementText(attachments) {
  return `附件：${attachments.map((attachment) => attachment.originalName).join("、")}`;
}

function terminalPromptWithAttachments(text, attachments) {
  if (!attachments.length) return text;
  const attachmentLines = attachments.map(
    (attachment) => `- ${attachment.originalName}：${attachment.path}`,
  );
  return [text, `请读取并处理以下附件：\n${attachmentLines.join("\n")}`].filter(Boolean).join("\n\n");
}

function rememberSubmittedAttachments(session, attachments) {
  for (const attachment of attachments) session.submittedAttachmentMetadata.set(attachment.path, attachment);
  while (session.submittedAttachmentMetadata.size > 100) {
    session.submittedAttachmentMetadata.delete(session.submittedAttachmentMetadata.keys().next().value);
  }
}

function writeAndSubmit(session, text, { paste, submitKey = "\r" }) {
  if (!text) return;
  session.terminal.write("\x15");
  setTimeout(() => {
    if (paste) {
      session.terminal.write(`\x1b[200~${text}\x1b[201~`);
    } else {
      session.terminal.write(text);
    }
    setTimeout(() => session.terminal.write(submitKey), 30);
  }, 20);
}

async function handleAppServerCommand(session, ws, value) {
  const raw = String(value || "").trim();
  const command = raw.split(/\s+/)[0].toLowerCase();
  const argument = raw.slice(command.length).trim();

  if (command === "/permissions") {
    send(ws, "app-command-result", {
      command,
      kind: "permissions",
      access: session.access,
      activeTurn: Boolean(session.turnState?.active),
    });
    return;
  }

  if (command === "/skills") {
    await sendAppServerSkills(session, ws, { openPicker: true });
    return;
  }

  if (command === "/status") {
    const payload = await appServerStatus(session);
    send(ws, "app-command-result", { command, kind: "status", ...payload });
    return;
  }

  if (command === "/usage") {
    send(ws, "app-command-result", { command, kind: "usage", ...(await appServerUsage(session)) });
    return;
  }

  if (command === "/model") {
    send(ws, "app-command-result", { command, kind: "models", ...(await appServerModels(session, argument)) });
    return;
  }

  if (command === "/fast") {
    const config = (await session.appServer.readConfig({ cwd: session.cwd }))?.config || {};
    const current = session.appServiceTier || config.service_tier || "default";
    session.appServiceTier = current === "priority" ? "default" : "priority";
    persistRestorableWebSession(session);
    send(ws, "app-command-result", {
      command,
      kind: "notice",
      title: "Fast mode",
      content: session.appServiceTier === "priority" ? "Fast 已开启，将从下一轮任务生效。" : "Fast 已关闭，将从下一轮任务生效。",
    });
    return;
  }

  if (command === "/goal") {
    send(ws, "app-command-result", { command, kind: "goal", ...(await appServerGoal(session, argument)) });
    return;
  }

  if (command === "/rename") {
    const title = cleanCustomTitle(argument);
    if (!title) throw new Error("请使用 /rename 新名称。");
    await session.appServer.setThreadName(title);
    session.title = title;
    await rememberSessionTitle(session.sessionId, title, agentHostForSession(session));
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
    send(ws, "app-command-result", { command, kind: "notice", title: "Rename", content: `Session 已重命名为“${title}”。` });
    return;
  }

  if (command === "/compact") {
    if (session.turnState.active || session.appServer.activeTurnId) throw new Error("当前任务仍在处理，完成后再压缩上下文。");
    await session.appServer.compactThread();
    send(ws, "app-command-result", { command, kind: "notice", title: "Compact", content: "已开始压缩当前 Session 的上下文。" });
    return;
  }

  if (command === "/diff") {
    if (session.hostId !== PERSONAL_AGENT_HOST.id) {
      throw new Error("公司 Session 暂不支持 /diff 快捷命令；可以直接让 Codex 检查远端 git diff。");
    }
    send(ws, "app-command-result", { command, kind: "text", title: "Working tree diff", ...(await appServerGitDiff(session.cwd)) });
    return;
  }

  if (command === "/review") {
    if (session.turnState.active || session.appServer.activeTurnId) throw new Error("当前任务仍在处理，完成后再启动 Review。");
    const result = await session.appServer.startReview({ type: "uncommittedChanges" });
    session.turnState.sequence += 1;
    session.turnState.active = true;
    const requirement = turnRequirement(session.turnState, "Review uncommitted changes", "original", "working");
    session.turnState.requirements = [requirement];
    session.turnState.turnId = result?.turn?.id || session.appServer.activeTurnId || "";
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
    send(ws, "app-command-result", { command, kind: "notice", title: "Review", content: "已开始检查当前工作区的未提交修改。" });
    return;
  }

  if (command === "/mcp") {
    send(ws, "app-command-result", { command, kind: "inventory", title: "MCP servers", ...(await appServerMcpInventory(session)) });
    return;
  }

  if (command === "/plugins") {
    send(ws, "app-command-result", { command, kind: "inventory", title: "Plugins", ...(await appServerPluginInventory(session)) });
    return;
  }

  if (command === "/hooks") {
    send(ws, "app-command-result", { command, kind: "inventory", title: "Hooks", ...(await appServerHookInventory(session)) });
    return;
  }

  throw new Error(`${command || "This command"} is not available in App Server mode.`);
}

async function appServerStatus(session) {
  const requests = session.ready
    ? await Promise.allSettled([
        session.appServer.readThread({ includeTurns: false }),
        session.appServer.readConfig({ cwd: session.cwd, includeLayers: false }),
        session.appServer.readRateLimits(),
        session.appServer.readAccount(),
      ])
    : [];
  const thread = fulfilledValue(requests[0]);
  const config = fulfilledValue(requests[1])?.config || {};
  const rateLimitResponse = fulfilledValue(requests[2]) || {};
  const account = fulfilledValue(requests[3])?.account || null;
  const usage =
    session.appTokenUsage ||
    (session.hostId === PERSONAL_AGENT_HOST.id
      ? await appServerDiskTokenUsage(session.sessionId)
      : null);
  if (usage && !session.appTokenUsage) session.appTokenUsage = usage;
  return {
    sessionId: session.sessionId,
    title: session.title || "New Codex session",
    project: session.project,
    cwd: session.cwd,
    engine: "App Server",
    cliVersion: appServerVersion(session.appServer.serverInfo?.userAgent) || thread?.cliVersion || "",
    sessionCliVersion: thread?.cliVersion || "",
    modelProvider: thread?.modelProvider || config.model_provider || "",
    model: session.appModel || config.model || "default",
    reasoningEffort: session.appReasoningEffort || config.model_reasoning_effort || "default",
    serviceTier: session.appServiceTier === "priority" ? "priority" : session.appServiceTier === "default" ? "default" : config.service_tier || "default",
    orchestrationMode: normalizeOrchestrationMode(session.orchestrationMode),
    orchestrationRoles: AUTO_ORCHESTRATION_ROLE_DEFAULTS,
    account: account
      ? {
          type: String(account.type || ""),
          email: String(account.email || ""),
          planType: String(account.planType || rateLimitResponse.rateLimits?.planType || ""),
        }
      : null,
    access: session.access,
    approvalPolicy: session.access === FULL_ACCESS_MODE ? "never" : "on-request",
    sandbox: session.access === FULL_ACCESS_MODE ? "danger-full-access" : "workspace-write",
    writableRoots:
      session.access === FULL_ACCESS_MODE
        ? [session.hostId === PERSONAL_AGENT_HOST.id ? "全部服务器文件" : `${session.hostLabel}主机全部文件`]
        : [session.cwd, "/tmp"],
    networkAccess: session.access === FULL_ACCESS_MODE ? "允许" : "受限",
    agentsFiles:
      session.hostId === PERSONAL_AGENT_HOST.id
        ? appServerInstructionFiles(session.cwd)
        : [],
    gitBranch: String(thread?.gitInfo?.branch || ""),
    activeTurn: Boolean(session.turnState?.active),
    tokenUsage: publicAppTokenUsage(usage, config.model_context_window),
    rateLimits: appServerRateLimits(rateLimitResponse),
    resetCredits: Number(rateLimitResponse.rateLimitResetCredits?.availableCount || 0),
  };
}

function publicAppTokenUsage(usage, fallbackContextWindow = 0) {
  if (!usage) return null;
  const contextUsedTokens = Number(usage.last?.totalTokens || 0);
  const modelContextWindow = Number(usage.modelContextWindow || fallbackContextWindow || 0);
  return {
    totalTokens: Number(usage.total?.totalTokens || 0),
    inputTokens: Number(usage.total?.inputTokens || 0),
    outputTokens: Number(usage.total?.outputTokens || 0),
    cachedInputTokens: Number(usage.total?.cachedInputTokens || 0),
    reasoningOutputTokens: Number(usage.total?.reasoningOutputTokens || 0),
    contextUsedTokens,
    modelContextWindow,
    contextAlert:
      contextUsedTokens >= 150_000
        ? "critical"
        : contextUsedTokens >= 100_000
          ? "watch"
          : "normal",
  };
}

function appServerVersion(userAgent) {
  return String(userAgent || "").match(/\b\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\b/)?.[0] || "";
}

async function appServerDiskTokenUsage(sessionId) {
  if (!isValidSessionId(sessionId)) return null;
  const file = await findCodexSessionFile(sessionId);
  if (!file) return null;
  try {
    return await extractSessionTokenUsageFromJsonl(file);
  } catch {
    return null;
  }
}

async function appServerUsage(session) {
  const [rateResult, usageResult, accountResult] = await Promise.allSettled([
    session.appServer.readRateLimits(),
    session.appServer.readAccountUsage(),
    session.appServer.readAccount(),
  ]);
  const rateResponse = fulfilledValue(rateResult) || {};
  const activity = fulfilledValue(usageResult) || {};
  const account = fulfilledValue(accountResult)?.account || null;
  return {
    account: account
      ? { type: String(account.type || ""), email: String(account.email || ""), planType: String(account.planType || "") }
      : null,
    rateLimits: appServerRateLimits(rateResponse),
    resetCredits: Number(rateResponse.rateLimitResetCredits?.availableCount || 0),
    credits: rateResponse.rateLimits?.credits || null,
    activitySummary: activity.summary || null,
    dailyUsage: Array.isArray(activity.dailyUsageBuckets) ? activity.dailyUsageBuckets.slice(-7) : [],
  };
}

function appServerRateLimits(response = {}) {
  const snapshots = [];
  const primarySnapshot = response.rateLimits || null;
  if (primarySnapshot) snapshots.push(primarySnapshot);
  for (const [id, snapshot] of Object.entries(response.rateLimitsByLimitId || {})) {
    if (!snapshot || id === primarySnapshot?.limitId) continue;
    snapshots.push({ ...snapshot, limitId: snapshot.limitId || id });
  }

  const windows = [];
  for (const snapshot of snapshots) {
    for (const [kind, window] of [
      ["primary", snapshot.primary],
      ["secondary", snapshot.secondary],
    ]) {
      if (!window) continue;
      windows.push({
        limitId: String(snapshot.limitId || "codex"),
        limitName: String(snapshot.limitName || ""),
        kind,
        usedPercent: clampInteger(window.usedPercent, 0, 100, 0),
        windowDurationMins: Number(window.windowDurationMins || 0),
        resetsAt: Number(window.resetsAt || 0),
      });
    }
  }
  return windows;
}

function appServerInstructionFiles(cwd) {
  const files = [];
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, "AGENTS.md");
    if (fsSync.existsSync(candidate)) files.push(candidate);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return files;
}

async function appServerModels(session, argument) {
  const [modelsResponse, configResponse] = await Promise.all([
    session.appServer.listModels(),
    session.appServer.readConfig({ cwd: session.cwd }),
  ]);
  const models = (Array.isArray(modelsResponse?.data) ? modelsResponse.data : []).filter((model) => !model.hidden);
  const config = configResponse?.config || {};
  if (argument) {
    const [requestedModel, requestedEffort] = argument.split(/\s+/);
    const selected = models.find((model) => model.id === requestedModel || model.model === requestedModel);
    if (!selected) throw new Error(`未知模型：${requestedModel}`);
    const efforts = (selected.supportedReasoningEfforts || []).map((entry) => entry.reasoningEffort);
    const effort = requestedEffort || (efforts.includes(session.appReasoningEffort || config.model_reasoning_effort) ? session.appReasoningEffort || config.model_reasoning_effort : selected.defaultReasoningEffort);
    if (effort && !efforts.includes(effort)) throw new Error(`${selected.displayName || selected.id} 不支持 ${effort} reasoning。`);
    session.appModel = selected.model || selected.id;
    session.appReasoningEffort = effort || "";
    persistRestorableWebSession(session);
  }
  return {
    currentModel: session.appModel || config.model || "default",
    currentReasoningEffort: session.appReasoningEffort || config.model_reasoning_effort || "default",
    activeTurn: Boolean(session.turnState.active),
    models: models.map((model) => ({
      id: String(model.id || model.model || ""),
      name: String(model.displayName || model.id || model.model || ""),
      description: String(model.description || ""),
      defaultReasoningEffort: String(model.defaultReasoningEffort || ""),
      reasoningEfforts: (model.supportedReasoningEfforts || []).map((entry) => String(entry.reasoningEffort || "")).filter(Boolean),
    })),
  };
}

async function appServerGoal(session, argument) {
  if (argument.toLowerCase() === "clear") {
    await session.appServer.clearThreadGoal();
    return { goal: null, changed: "cleared" };
  }
  if (argument) {
    if (argument.length > 4_000) throw new Error("Goal 不能超过 4,000 个字符。");
    const response = await session.appServer.setThreadGoal(argument);
    return { goal: response?.goal || null, changed: "set" };
  }
  const response = await session.appServer.readThreadGoal();
  return { goal: response?.goal || null, changed: "" };
}

async function appServerMcpInventory(session) {
  const response = await session.appServer.listMcpServers();
  const items = (Array.isArray(response?.data) ? response.data : []).map((server) => ({
    name: String(server.serverInfo?.title || server.name || "MCP"),
    detail: `${Object.keys(server.tools || {}).length} tools · ${server.authStatus || "auth unknown"}`,
  }));
  return { items, note: items.length ? "显示当前 Session 已连接的 MCP Server。" : "当前没有可用的 MCP Server。" };
}

async function appServerPluginInventory(session) {
  const response = await session.appServer.listPlugins({ cwds: [session.cwd] });
  const all = (response?.marketplaces || []).flatMap((marketplace) => marketplace.plugins || []);
  const installed = all.filter((plugin) => plugin.installed || plugin.enabled);
  const items = installed.slice(0, 50).map((plugin) => ({
    name: String(plugin.interface?.displayName || plugin.name || plugin.id || "Plugin"),
    detail: plugin.enabled ? "已启用" : "已安装",
  }));
  return {
    items,
    note: installed.length ? `已安装 ${installed.length} 个；市场中共发现 ${all.length} 个。` : `尚未安装 Plugin；市场中发现 ${all.length} 个可用项。`,
  };
}

async function appServerHookInventory(session) {
  const response = await session.appServer.listHooks({ cwds: [session.cwd] });
  const entries = Array.isArray(response?.data) ? response.data : [];
  const hooks = entries.flatMap((entry) => entry.hooks || []);
  const warnings = entries.flatMap((entry) => entry.warnings || []);
  const errors = entries.flatMap((entry) => entry.errors || []);
  return {
    items: hooks.slice(0, 50).map((hook) => ({
      name: String(hook.key || hook.eventName || "Hook"),
      detail: `${hook.eventName || "event"} · ${hook.enabled ? "已启用" : "已停用"} · ${hook.trustStatus || "unknown"}`,
    })),
    note: hooks.length ? `${hooks.length} 个 Hook · ${warnings.length} 个提醒 · ${errors.length} 个错误。` : "当前工作区没有配置 Hook。",
  };
}

async function appServerGitDiff(cwd) {
  const status = await execFileOutput("git", ["status", "--short"], { cwd });
  const diff = await execFileOutput("git", ["diff", "--no-ext-diff", "--text", "HEAD", "--"], { cwd });
  const content = [status.trim() ? `Status\n${status.trim()}` : "", diff.trim() ? `Diff\n${diff.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");
  return {
    content: content || "工作区没有未提交修改。",
    note: "未跟踪文件显示名称；Diff 内容包含已暂存和未暂存修改。",
  };
}

function execFileOutput(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, timeout: 10_000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function fulfilledValue(result) {
  return result?.status === "fulfilled" ? result.value : null;
}

async function sendAppServerSkills(session, ws, { forceReload = false, openPicker = false } = {}) {
  if (!session.ready || session.exited) throw new Error("App Server is still restoring the session.");
  const skills = await getAppServerSkills(session, { forceReload });
  send(ws, "app-skills", {
    openPicker,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      scope: skill.scope,
    })),
  });
}

async function getAppServerSkills(session, { forceReload = false } = {}) {
  if (session.appSkills && !forceReload) return session.appSkills;
  const response = await session.appServer.listSkills({ cwds: [session.cwd], forceReload });
  const seen = new Set();
  const skills = [];
  for (const entry of Array.isArray(response?.data) ? response.data : []) {
    for (const skill of Array.isArray(entry?.skills) ? entry.skills : []) {
      const name = String(skill?.name || "").trim();
      const skillPath = String(skill?.path || "").trim();
      const key = `${name}\u0000${skillPath}`;
      if (!name || !skillPath || skill?.enabled === false || seen.has(key)) continue;
      seen.add(key);
      skills.push({
        name,
        path: skillPath,
        description: String(skill?.description || "").trim(),
        scope: String(skill?.scope || "").trim(),
      });
    }
  }
  skills.sort((left, right) => left.name.localeCompare(right.name));
  session.appSkills = skills;
  return skills;
}

async function resolveAppServerSkills(session, names) {
  const requested = new Set((Array.isArray(names) ? names : []).map((name) => String(name).toLowerCase()));
  if (!requested.size) return [];
  const available = await getAppServerSkills(session);
  return available.filter((skill) => requested.has(skill.name.toLowerCase())).slice(0, 8);
}

function requestedAppSkillNames(text, supplied) {
  const names = Array.isArray(supplied) ? supplied.map(String) : [];
  const pattern = /(?:^|\s)\$([a-zA-Z0-9][a-zA-Z0-9_:-]*)/g;
  for (const match of String(text || "").matchAll(pattern)) names.push(match[1]);
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 8);
}

function appServerPromptInput(text, skills, attachments = []) {
  const input = skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path }));
  if (String(text || "").trim()) input.push({ type: "text", text });
  for (const attachment of attachments) {
    input.push(
      isAudioAttachment(attachment)
        ? { type: "localAudio", path: attachment.path }
        : attachment.mime.startsWith("image/")
        ? { type: "localImage", path: attachment.path }
        : { type: "mention", name: attachment.originalName, path: attachment.path },
    );
  }
  return input;
}

function isAudioAttachment(attachment) {
  const mime = String(attachment?.mime || "");
  if (mime.startsWith("audio/")) return true;
  if (mime && mime !== "application/octet-stream") return false;
  return /\.(?:aac|aif|aiff|caf|flac|m4a|mp3|oga|ogg|opus|wav|weba|webm)$/i.test(
    String(attachment?.originalName || attachment?.path || ""),
  );
}

function appServerTurnAccess(session) {
  const settings = {
    approvalPolicy: session.access === FULL_ACCESS_MODE ? "never" : "on-request",
    sandboxPolicy:
      session.access === FULL_ACCESS_MODE
        ? { type: "dangerFullAccess" }
        : { type: "workspaceWrite", writableRoots: [session.cwd], networkAccess: false },
  };
  if (session.appModel) settings.model = session.appModel;
  if (session.appReasoningEffort) settings.effort = session.appReasoningEffort;
  if (session.appServiceTier === "priority") settings.serviceTier = "priority";
  if (session.appServiceTier === "default") settings.serviceTier = null;
  return settings;
}

function normalizeOrchestrationMode(value) {
  return value === "manual" ? "manual" : "auto";
}

function appServerTurnAdditionalContext(session, personalMemoryContext) {
  return buildAppServerTurnAdditionalContext(session.orchestrationMode, personalMemoryContext);
}

async function appServerPersonalMemory(session, prompt) {
  if (session.hostId !== PERSONAL_AGENT_HOST.id) {
    return { additionalContext: undefined, citation: null };
  }
  try {
    const memory = await personalMemoryContextForPrompt(CODEX_HOME, {
      cwd: session.cwd,
      title: session.title,
      prompt,
      workspaceRoot: WORKSPACE_ROOT,
      memoryProjectMode: session.memoryProjectMode,
      memoryProjects: session.memoryProjects,
      knownProjects: workspaceMemoryProjectNames(),
    });
    session.memoryProjectMode = memory.projectMode;
    session.memoryProjects = memory.projects;
    session.memoryProjectSource = memory.projectSource;
    rememberAgentSessionMemoryRouting(session);
    return {
      additionalContext: memory.value
        ? { "personal-memory": { kind: "application", value: memory.value } }
        : undefined,
      citation: memory.citation,
    };
  } catch (error) {
    console.error(`Failed to load personal memory context: ${error.message}`);
    return { additionalContext: undefined, citation: null };
  }
}

async function updateSessionMemoryRouting(session, options = {}) {
  if (session.hostId !== PERSONAL_AGENT_HOST.id) {
    session.memoryProjectMode = "auto";
    session.memoryProjects = [];
    session.memoryProjectSource = "global";
    rememberAgentSessionMemoryRouting(session);
    return { value: "", projectMode: "auto", projects: [], projectSource: "global" };
  }
  const mode = options.mode === "manual" ? "manual" : "auto";
  const projects = Object.hasOwn(options, "projects") ? options.projects : session.memoryProjects;
  const memory = await personalMemoryContextForPrompt(CODEX_HOME, {
    cwd: session.cwd,
    title: session.title,
    workspaceRoot: WORKSPACE_ROOT,
    memoryProjectMode: mode,
    memoryProjects: projects,
    knownProjects: workspaceMemoryProjectNames(),
  });
  session.memoryProjectMode = memory.projectMode;
  session.memoryProjects = memory.projects;
  session.memoryProjectSource = memory.projectSource;
  rememberAgentSessionMemoryRouting(session);
  return memory;
}

function queuePersonalMemoryCitation(session, requirementId, citation) {
  session.pendingPersonalMemoryCitations.push({ requirementId, citation: normalizeMemoryCitation(citation) });
}

function removeQueuedPersonalMemoryCitation(session, requirementId) {
  session.pendingPersonalMemoryCitations = session.pendingPersonalMemoryCitations.filter(
    (item) => item.requirementId !== requirementId,
  );
}

function mergeMemoryCitations(...citations) {
  const normalized = citations.map(normalizeMemoryCitation).filter(Boolean);
  if (!normalized.length) return null;
  const entries = [];
  const entryKeys = new Set();
  for (const citation of normalized) {
    for (const entry of citation.entries || []) {
      const key = `${entry.path}|${entry.lineStart}|${entry.lineEnd}|${entry.note}`;
      if (entryKeys.has(key)) continue;
      entryKeys.add(key);
      entries.push(entry);
    }
  }
  return {
    entries: entries.slice(0, 30),
    threadIds: [...new Set(normalized.flatMap((citation) => citation.threadIds || []))].slice(0, 30),
  };
}

async function submitAppServerPrompt(
  session,
  text,
  requestedMode,
  skillNames = [],
  attachments = [],
  requirementText = text,
) {
  if (!session.ready || session.exited) throw new Error("App Server is still starting or has exited.");
  const state = session.turnState;
  const appServer = session.appServer;
  const wantsQueue = requestedMode === "queue";
  const skills = await resolveAppServerSkills(session, skillNames);
  const activeSkills = skills.map((skill) => skill.name);
  const input = (value) => appServerPromptInput(value, skills, attachments);
  const personalMemory = await appServerPersonalMemory(session, requirementText);
  let lateSteer = false;

  if (wantsQueue && appServer.activeTurnId) {
    const requirement = turnRequirement(state, requirementText, "queued", "queued");
    state.queuedTurns.push(requirement);
    trimTrackedRequirements(state);
    queuePersonalMemoryCitation(session, requirement.id, personalMemory.citation);
    void appServer
      .queueTurn(input(queuePromptText(text)), {
        ...appServerTurnAccess(session),
        additionalContext: appServerTurnAdditionalContext(session, personalMemory.additionalContext),
        clientUserMessageId: requirement.id,
      })
      .catch((error) => {
        removeQueuedPersonalMemoryCitation(session, requirement.id);
        requirement.status = "failed";
        if (!appServer.activeTurnId) state.active = false;
        appendSessionOutput(session, `\r\n\x1b[31mQueued prompt failed: ${error.message}\x1b[0m\r\n`);
        persistRestorableWebSession(session);
        broadcast(session, "status", publicSession(session));
      });
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
    return { deliveryMode: "queue", skills: activeSkills };
  }

  if (appServer.activeTurnId) {
    const requirement = turnRequirement(state, requirementText, "followup", "working");
    state.requirements.push(requirement);
    trimTrackedRequirements(state);
    try {
      const result = await appServer.steerTurn(input(steerPromptText(text, state.requirements.length)), {
        additionalContext: appServerTurnAdditionalContext(session, personalMemory.additionalContext),
        clientUserMessageId: requirement.id,
      });
      state.active = true;
      state.turnId = result.turnId;
      session.personalMemoryCitationsByTurn.set(
        result.turnId,
        mergeMemoryCitations(session.personalMemoryCitationsByTurn.get(result.turnId), personalMemory.citation),
      );
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      return { deliveryMode: "steer", skills: activeSkills };
    } catch (error) {
      state.requirements = state.requirements.filter((item) => item.id !== requirement.id);
      if (!/no active turn/i.test(error.message)) throw error;
      lateSteer = true;
    }
  }

  for (const requirement of state.requirements) requirement.status = "completed";
  state.sequence += 1;
  state.active = true;
  state.stopping = false;
  state.interrupted = false;
  state.interruptedAt = "";
  state.turnId = "";
  const requirement = turnRequirement(
    state,
    requirementText,
    wantsQueue || lateSteer ? "queued" : "original",
    "working",
  );
  state.requirements = [requirement];
  session.lastAssistantMessage = "";
  queuePersonalMemoryCitation(session, requirement.id, personalMemory.citation);
  let turn;
  try {
    turn = await appServer.startTurn(input(lateSteer ? lateFollowupPromptText(text) : text), {
      ...appServerTurnAccess(session),
      additionalContext: appServerTurnAdditionalContext(session, personalMemory.additionalContext),
      clientUserMessageId: requirement.id,
    });
  } catch (error) {
    removeQueuedPersonalMemoryCitation(session, requirement.id);
    throw error;
  }
  state.turnId = appServer.activeTurnId ? turn.id : state.turnId;
  state.active = Boolean(appServer.activeTurnId);
  persistRestorableWebSession(session);
  broadcast(session, "status", publicSession(session));
  return { deliveryMode: wantsQueue || lateSteer ? "queue-fallback" : "new", skills: activeSkills };
}

async function drainAppServerStartupPrompts(session) {
  while (session.ready && !session.exited && session.pendingStartupPrompts.length) {
    const prompt = session.pendingStartupPrompts.shift();
    try {
      const submission = await submitAppServerPrompt(
        session,
        prompt.text,
        prompt.deliveryMode,
        prompt.skillNames,
        prompt.attachments,
        prompt.requirementText,
      );
      if (prompt.activatesThink) {
        session.thinkSkillActivated = true;
        session.thinkSkillActivationPending = false;
      }
      session.lastActivityAt = new Date().toISOString();
      persistRestorableWebSession(session);
      broadcast(session, "status", publicSession(session));
      broadcast(session, "control-ack", {
        kind: "startup-submit",
        receivedAt: Date.now(),
        skills: submission.skills,
        turnState: publicTurnState(session.turnState),
      });
    } catch (error) {
      if (prompt.activatesThink) session.thinkSkillActivationPending = false;
      broadcast(session, "error", { message: `Queued prompt was not sent: ${error.message}`, preservePrompt: true });
    }
  }
}

function publicAppTranscript(session) {
  return {
    restoredTurnCount: session.restoredTurnCount || 0,
    hasEarlierTurns: Boolean(session.restoredHistoryHasMore),
    loadingEarlier: Boolean(session.restoredHistoryLoading),
    items: session.appTranscript.map((item) => ({ ...item })),
  };
}

async function loadEarlierAppServerHistory(session) {
  if (!session.ready || session.exited || session.restoredHistoryLoading || !session.restoredHistoryCursor) return;
  session.restoredHistoryLoading = true;
  broadcast(session, "app-history-state", { loadingEarlier: true });
  try {
    const page = await session.appServer.listThreadTurns({
      limit: APP_HISTORY_PAGE_LIMIT,
      cursor: session.restoredHistoryCursor,
    });
    const turns = Array.isArray(page?.data) ? page.data : [];
    prependAppServerTranscript(session, turns);
    session.restoredTurnCount = new Set(session.appTranscript.map((item) => item.turnId).filter(Boolean)).size;
    session.restoredHistoryCursor = page?.nextCursor || null;
    session.restoredHistoryHasMore = Boolean(page?.nextCursor);
    logAgentEvent("app-server-earlier-history", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      loadedTurns: turns.length,
      restoredTurns: session.restoredTurnCount,
      hasEarlierTurns: session.restoredHistoryHasMore,
    });
  } finally {
    session.restoredHistoryLoading = false;
    broadcast(session, "app-transcript", { ...publicAppTranscript(session), prepended: true });
  }
}

async function locateAppServerHistoryTurn(session, turnId, itemId = "") {
  if (
    session.appTranscript.some(
      (item) => item.turnId === turnId && (!itemId || item.id === itemId),
    )
  ) {
    return 0;
  }

  let loadedTurns = 0;
  while (session.restoredHistoryCursor && loadedTurns < APP_SEARCH_HYDRATE_MAX_TURNS) {
    const page = await session.appServer.listThreadTurns({
      limit: APP_SEARCH_HYDRATE_PAGE_LIMIT,
      cursor: session.restoredHistoryCursor,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = Array.isArray(page?.data) ? page.data : [];
    prependAppServerTranscript(session, turns);
    loadedTurns += turns.length;
    session.restoredHistoryCursor = page?.nextCursor || null;
    session.restoredHistoryHasMore = Boolean(page?.nextCursor);
    session.restoredTurnCount = new Set(session.appTranscript.map((item) => item.turnId).filter(Boolean)).size;
    if (turns.some((turn) => String(turn?.id || "") === turnId) || !turns.length) break;
  }
  broadcast(session, "app-transcript", { ...publicAppTranscript(session), prepended: true, readingPositionItemId: itemId });
  return loadedTurns;
}

async function hydrateAppServerSearchResult(session, turnCursor, itemId) {
  if (session.appTranscript.some((item) => item.id === itemId)) return 0;

  const turns = [];
  let cursor = turnCursor;
  let pageCount = 0;
  const existingTurnIds = new Set(session.appTranscript.map((item) => item.turnId).filter(Boolean));

  while (cursor && turns.length < APP_SEARCH_HYDRATE_MAX_TURNS) {
    const page = await session.appServer.listThreadTurns({
      limit: APP_SEARCH_HYDRATE_PAGE_LIMIT,
      cursor,
      sortDirection: "asc",
      itemsView: "full",
    });
    const pageTurns = Array.isArray(page?.data) ? page.data : [];
    turns.push(...pageTurns);
    if (pageTurns.some((turn) => existingTurnIds.has(String(turn?.id || "")))) break;
    cursor = page?.nextCursor || null;
    pageCount += 1;
    if (!pageTurns.length || pageCount >= Math.ceil(APP_SEARCH_HYDRATE_MAX_TURNS / APP_SEARCH_HYDRATE_PAGE_LIMIT)) break;
  }

  mergeAppServerTranscriptTurns(session, turns, { historical: true });
  session.restoredTurnCount = new Set(session.appTranscript.map((item) => item.turnId).filter(Boolean)).size;
  broadcast(session, "app-transcript", { ...publicAppTranscript(session), searchHydratedItemId: itemId });
  return turns.length;
}

function restoreAppServerTranscript(session, thread, { resumed = false } = {}) {
  const turns = Array.isArray(thread?.turns) ? [...thread.turns] : [];
  turns.sort((a, b) => (a?.startedAt ?? 0) - (b?.startedAt ?? 0));
  session.appTranscript = [];
  session.restoredTurnCount = resumed ? turns.length : 0;

  for (const item of appTranscriptItemsFromTurns(session, turns, { historical: resumed })) {
    upsertAppTranscriptItem(session, item, { notify: false });
  }
}

function restoreResumedActiveTurnState(session, turns) {
  const activeTurnId = String(session.appServer?.activeTurnId || "");
  if (!activeTurnId) return;
  const activeTurn = (Array.isArray(turns) ? turns : []).find(
    (turn) => String(turn?.id || "") === activeTurnId && turn?.status === "inProgress",
  );
  if (!activeTurn) return;

  const state = session.turnState;
  state.active = true;
  state.stopping = false;
  state.interrupted = false;
  state.interruptedAt = "";
  state.turnId = activeTurnId;
  for (const requirement of state.requirements) {
    if (requirement.status === "interrupted") requirement.status = "working";
  }

  const hasWorkingRequirement = state.requirements.some((requirement) => requirement.status === "working");
  if (!hasWorkingRequirement) {
    const prompt = [...session.appTranscript]
      .reverse()
      .find((item) => item.turnId === activeTurnId && item.type === "user")
      ?.text?.trim();
    if (prompt) {
      state.sequence += 1;
      state.requirements = [turnRequirement(state, prompt, "original", "working")];
    }
  }
  logAgentEvent("session-active-turn-restored", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    turnId: activeTurnId,
  });
}

function prependAppServerTranscript(session, turns) {
  mergeAppServerTranscriptTurns(session, turns, { historical: true });
}

function mergeAppServerTranscriptTurns(session, turns, { historical = false } = {}) {
  const incoming = appTranscriptItemsFromTurns(session, turns, { historical }).map(normalizeAppTranscriptItem);
  const byId = new Map();
  let sequence = 0;
  for (const item of [...session.appTranscript, ...incoming]) {
    const existing = byId.get(item.id);
    byId.set(item.id, {
      item: existing ? normalizeAppTranscriptItem({ ...existing.item, ...item }) : item,
      sequence: existing?.sequence ?? sequence++,
    });
  }
  session.appTranscript = [...byId.values()]
    .sort((left, right) => {
      const leftTime = left.item.turnStartedAt ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.item.turnStartedAt ?? Number.MAX_SAFE_INTEGER;
      return leftTime === rightTime ? left.sequence - right.sequence : leftTime - rightTime;
    })
    .map((entry) => entry.item);
  if (session.appTranscript.length > MAX_APP_TRANSCRIPT_ITEMS) {
    session.appTranscript.splice(0, session.appTranscript.length - MAX_APP_TRANSCRIPT_ITEMS);
  }
}

async function forkAppServerSessionInBackground(session, lastTurnId) {
  const sourceThreadId = session.sessionId;
  const title = branchThreadTitle(session.title, "分支");
  const agentHost = agentHostForSession(session);
  const result = await withStandaloneAppServer(agentHost, async (client) => {
    const forked = await client.forkThread(
      {
        threadId: sourceThreadId,
        lastTurnId,
        cwd: session.cwd,
        approvalPolicy: session.access === FULL_ACCESS_MODE ? "never" : "on-request",
        sandbox: session.access === FULL_ACCESS_MODE ? "danger-full-access" : "workspace-write",
        developerInstructions: AGENT_WEB_DEVELOPER_INSTRUCTIONS,
        excludeTurns: true,
        deferGoalContinuation: true,
      },
      { adopt: false },
    );
    if (forked?.thread?.id && title) {
      await client.setThreadName(title, forked.thread.id).catch((error) => {
        logAgentEvent("thread-native-name-failed", {
          codexSessionId: forked.thread.id,
          message: cleanClientLogValue(error.message, 300),
        });
      });
    }
    return forked;
  });
  const threadId = String(result?.thread?.id || "");
  if (!threadId) throw new Error("Codex 没有返回新分支 ID。");
  await rememberSessionTitle(threadId, title, agentHost).catch((error) => {
    logAgentEvent("thread-sidecar-name-failed", {
      codexSessionId: threadId,
      message: cleanClientLogValue(error.message, 300),
    });
  });
  rememberAgentSessionAccess(threadId, session.access, agentHost.id);
  rememberAgentSessionRelation(
    threadId,
    {
      forkedFromId: sourceThreadId,
      forkedFromTitle: session.title,
    },
    agentHost.id,
  );
  logAgentEvent("thread-fork-created", {
    webSessionId: session.id,
    sourceThreadId,
    forkedThreadId: threadId,
    lastTurnId,
    mode: "new-web-session",
  });
  return {
    threadId,
    hostId: agentHost.id,
    title,
    project: session.project,
    transport: APP_SERVER_TRANSPORT,
    access: session.access,
    forkedFromId: sourceThreadId,
  };
}

async function editAndForkAppServerSession(session, { beforeTurnId, editedText, attachments, sourceTitle }) {
  const sourceThreadId = session.sessionId;
  const title = branchThreadTitle(sourceTitle, "编辑分支");
  let forkedThreadId = "";
  try {
    const result = await session.appServer.forkThread({
      threadId: sourceThreadId,
      beforeTurnId,
      cwd: session.cwd,
      approvalPolicy: session.access === FULL_ACCESS_MODE ? "never" : "on-request",
      sandbox: session.access === FULL_ACCESS_MODE ? "danger-full-access" : "workspace-write",
      developerInstructions: AGENT_WEB_DEVELOPER_INSTRUCTIONS,
      excludeTurns: true,
      deferGoalContinuation: true,
    });
    const thread = result?.thread;
    if (!thread?.id) throw new Error("Codex 没有返回编辑分支 ID。");
    forkedThreadId = thread.id;
    session.sessionId = thread.id;
    session.forkedFromId = sourceThreadId;
    session.forkedFromTitle = sourceTitle || "";
    session.parentThreadId = String(thread.parentThreadId || "");
    if (!session.parentThreadId) session.parentThreadTitle = "";
    session.title = title;
    session.turnState = restoreTurnState();
    session.pendingStartupPrompts = [];
    session.personalMemoryCitationsByTurn.clear();
    session.lastAssistantMessage = "";
    persistRestorableWebSession(session);

    await session.appServer.setThreadName(title, thread.id).catch((error) => {
      logAgentEvent("thread-native-name-failed", {
        codexSessionId: thread.id,
        message: cleanClientLogValue(error.message, 300),
      });
    });
    const recentPage = await session.appServer
      .listThreadTurns({ limit: APP_INITIAL_TURN_LIMIT })
      .catch((error) => {
        logAgentEvent("thread-fork-history-failed", {
          codexSessionId: thread.id,
          message: cleanClientLogValue(error.message, 300),
        });
        return { data: Array.isArray(thread.turns) ? thread.turns : [], nextCursor: null };
      });
    restoreAppServerTranscript(session, { ...thread, turns: recentPage?.data || [] }, { resumed: true });
    session.restoredHistoryCursor = recentPage?.nextCursor || null;
    session.restoredHistoryHasMore = Boolean(recentPage?.nextCursor);
    session.restoredTurnCount = Array.isArray(recentPage?.data) ? recentPage.data.length : 0;
    const agentHost = agentHostForSession(session);
    await rememberSessionTitle(session.sessionId, title, agentHost).catch((error) => {
      logAgentEvent("thread-sidecar-name-failed", {
        codexSessionId: thread.id,
        message: cleanClientLogValue(error.message, 300),
      });
    });
    rememberAgentSessionAccess(session.sessionId, session.access, session.hostId);
    rememberAgentSessionRelation(
      session.sessionId,
      {
        forkedFromId: sourceThreadId,
        forkedFromTitle: sourceTitle,
        parentThreadId: session.parentThreadId,
        parentThreadTitle: session.parentThreadTitle,
      },
      agentHost.id,
    );
    rememberAgentSessionMemoryRouting(session);

    broadcast(session, "app-transcript", publicAppTranscript(session));
    broadcast(session, "status", publicSession(session));

    const requirementText = editedText || attachmentRequirementText(attachments);
    const skillNames = requestedAppSkillNames(editedText);
    const submission = await submitAppServerPrompt(
      session,
      editedText,
      "auto",
      skillNames,
      attachments,
      requirementText,
    );
    session.lastActivityAt = new Date().toISOString();
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
    let sourceArchived = false;
    try {
      await setSessionArchived(sourceThreadId, true, agentHost);
      sourceArchived = true;
    } catch (error) {
      logAgentEvent("thread-edit-source-archive-failed", {
        sourceThreadId,
        forkedThreadId: session.sessionId,
        message: cleanClientLogValue(error.message, 300),
      });
    }
    logAgentEvent("thread-fork-created", {
      webSessionId: session.id,
      sourceThreadId,
      forkedThreadId: session.sessionId,
      beforeTurnId,
      mode: "edit-current-web-session-source-archived",
    });
    return {
      sourceThreadId,
      sessionId: session.sessionId,
      title,
      sourceArchived,
      deliveryMode: submission.deliveryMode,
      skills: submission.skills,
    };
  } catch (error) {
    if (forkedThreadId && error && typeof error === "object") {
      error.branchCreated = true;
      error.forkedThreadId = forkedThreadId;
    }
    throw error;
  }
}

async function sendAppServerSubagents(session, ws) {
  const response = await session.appServer.listThreads({
    ancestorThreadId: session.sessionId,
    limit: APP_THREAD_TREE_PAGE_LIMIT,
    sortKey: "updated_at",
    sortDirection: "desc",
    useStateDbOnly: true,
  });
  const profiles = await readAgentRoleProfiles(session);
  const roles = AUTO_ORCHESTRATION_ROLE_DEFAULTS.map((defaults) => {
    const profile = profiles.get(defaults.name) || {};
    return {
      ...defaults,
      description: profile.description || defaults.description,
      model: profile.model || defaults.model,
      reasoningEffort: profile.reasoningEffort || defaults.reasoningEffort,
    };
  });
  const threads = Array.isArray(response?.data) ? response.data : [];
  const agents = await Promise.all(
    threads.map(async (thread) => {
      const id = String(thread?.id || "");
      const metadata = session.collabAgentMetadata.get(id) || {};
      const profile = profiles.get(String(thread?.agentRole || "")) || {};
      let activeTurnId = "";
      if (String(thread?.status?.type || "") === "active") {
        const liveThread = await session.appServer.readThread({ threadId: id, includeTurns: true }).catch(() => null);
        activeTurnId = activeTurnFromThread(liveThread)?.id || "";
      }
      return {
        id,
        name: cleanCustomTitle(thread?.name) || cleanTitle(thread?.preview) || "子 Agent",
        nickname: String(thread?.agentNickname || ""),
        role: String(thread?.agentRole || ""),
        roleDescription: String(profile.description || ""),
        status: threadStatusLabel(thread?.status),
        statusType: String(thread?.status?.type || ""),
        state: String(metadata.state || ""),
        stateMessage: String(metadata.stateMessage || ""),
        model: String(metadata.model || profile.model || ""),
        reasoningEffort: String(metadata.reasoningEffort || profile.reasoningEffort || ""),
        prompt: trimAppTranscriptValue(metadata.prompt, 4_000),
        activeTurnId,
        canStop: Boolean(activeTurnId),
        updatedAt: unixSecondsToIso(thread?.updatedAt),
        project: agentHostProject(
          resolveAgentHost(AGENT_HOSTS, session.hostId) || PERSONAL_AGENT_HOST,
          String(thread?.cwd || session.cwd),
        ),
      };
    }),
  );
  send(ws, "app-command-result", {
    kind: "subagents",
    title: "Agent 管理",
    orchestrationMode: normalizeOrchestrationMode(session.orchestrationMode),
    roles,
    agents,
    note: agents.length
      ? "这里显示当前 Session 树中的子 Agent。打开可进入完整线程；运行中的 Agent 可以单独停止。"
      : normalizeOrchestrationMode(session.orchestrationMode) === "auto"
        ? "当前没有子 Agent。Auto 只会在确实节省主线程上下文或等待时间时委派。"
        : "当前没有子 Agent。手动模式只在你明确要求时委派。",
  });
}

function rememberCollabAgentMetadata(session, item) {
  if (item?.type !== "collabAgentToolCall") return;
  for (const receiverThreadId of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) {
    const id = String(receiverThreadId || "");
    if (!id) continue;
    const previous = session.collabAgentMetadata.get(id) || {};
    const agentState = item.agentsStates?.[id] || {};
    session.collabAgentMetadata.set(id, {
      ...previous,
      prompt: item.prompt || previous.prompt || "",
      model: item.model || previous.model || "",
      reasoningEffort: item.reasoningEffort || previous.reasoningEffort || "",
      state: agentState.status || previous.state || "",
      stateMessage: agentState.message || previous.stateMessage || "",
      tool: item.tool || previous.tool || "",
    });
  }
}

async function readAgentRoleProfiles(session) {
  const profiles = new Map();
  if (session?.hostId !== PERSONAL_AGENT_HOST.id) return profiles;
  const directory = path.join(CODEX_HOME, "agents");
  let files;
  try {
    files = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return profiles;
  }
  await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
      .map(async (entry) => {
        const role = entry.name.slice(0, -5);
        try {
          const source = await fs.readFile(path.join(directory, entry.name), "utf8");
          profiles.set(role, {
            description: tomlQuotedValue(source, "description"),
            model: tomlQuotedValue(source, "model"),
            reasoningEffort: tomlQuotedValue(source, "model_reasoning_effort"),
          });
        } catch {
          // A malformed optional role profile should not hide the live Agent list.
        }
      }),
  );
  return profiles;
}

function tomlQuotedValue(source, key) {
  const match = String(source || "").match(
    new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*(['"])(.*?)\\1\\s*$`, "m"),
  );
  return match ? match[2] : "";
}

function activeTurnFromThread(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return [...turns].reverse().find((turn) => turn?.status === "inProgress") || null;
}

async function stopAppServerSubagent(session, threadId) {
  if (!threadId || threadId === session.sessionId) throw new Error("请选择一个子 Agent。");
  const descendants = await session.appServer.listThreads({
    ancestorThreadId: session.sessionId,
    limit: APP_THREAD_TREE_MAX_THREADS,
    sortKey: "updated_at",
    sortDirection: "desc",
    useStateDbOnly: true,
  });
  const target = (Array.isArray(descendants?.data) ? descendants.data : []).find(
    (thread) => String(thread?.id || "") === threadId,
  );
  if (!target) throw new Error("这个线程不属于当前 Session 的子 Agent。");
  const thread = await session.appServer.readThread({ threadId, includeTurns: true });
  const turn = activeTurnFromThread(thread);
  if (!turn?.id) throw new Error("这个 Agent 当前没有正在运行的任务。");
  await session.appServer.interruptThreadTurn(threadId, turn.id);
  return { threadId, turnId: turn.id };
}

async function listAllAppServerThreads(client, archived) {
  const threads = [];
  let cursor = null;
  do {
    const page = await client.listThreads({
      archived,
      cursor,
      limit: APP_THREAD_TREE_PAGE_LIMIT,
      sortKey: "created_at",
      sortDirection: "asc",
      sourceKinds: APP_THREAD_SOURCE_KINDS,
      useStateDbOnly: false,
    });
    threads.push(...(Array.isArray(page?.data) ? page.data : []));
    cursor = page?.nextCursor || null;
  } while (cursor && threads.length < APP_THREAD_TREE_MAX_THREADS);
  return threads.slice(0, APP_THREAD_TREE_MAX_THREADS).map((thread) => ({ thread, archived }));
}

async function readCodexThreadRelationsFromFiles(threadIds) {
  const wanted = new Set([...threadIds].map(String).filter(isValidSessionId));
  if (!wanted.size) return new Map();
  const files = [
    ...(await walkFiles(CODEX_SESSIONS_ROOT)),
    ...(await walkFiles(CODEX_ARCHIVED_SESSIONS_ROOT)),
  ].filter((file) => file.endsWith(".jsonl") && wanted.has(sessionIdFromFilename(file)));
  const entries = await Promise.all(
    files.map(async (file) => {
      const id = sessionIdFromFilename(file);
      const firstLine = await readFirstLine(file);
      if (!firstLine) return null;
      try {
        const payload = JSON.parse(firstLine)?.payload || {};
        return [
          id,
          {
            forkedFromId: String(payload.forked_from_id || payload.forkedFromId || ""),
            parentThreadId: String(payload.parent_thread_id || payload.parentThreadId || ""),
          },
        ];
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter(Boolean));
}

function firstValidThreadId(...values) {
  return values.map((value) => String(value || "")).find(isValidSessionId) || "";
}

async function sendAppServerThreadTree(session, ws) {
  const agentHost = agentHostForSession(session);
  const catalog = await Promise.all([
    listAllAppServerThreads(session.appServer, false),
    listAllAppServerThreads(session.appServer, true),
  ]);
  const entries = catalog.flat();
  const byId = new Map(entries.map((entry) => [String(entry.thread?.id || ""), entry]));
  let current = byId.get(session.sessionId)?.thread || null;
  if (!current) {
    current = await session.appServer.readThread({ threadId: session.sessionId, includeTurns: false });
    if (current?.id) byId.set(current.id, { thread: current, archived: false });
  }

  const [fileRelations, persistedRecords] = await Promise.all([
    agentHost.type === "local"
      ? readCodexThreadRelationsFromFiles(byId.keys())
      : Promise.resolve(new Map()),
    Promise.resolve(
      Object.fromEntries(
        Object.entries(readPersistedWebSessions()).filter(
          ([, record]) => (record.hostId || PERSONAL_AGENT_HOST.id) === agentHost.id,
        ),
      ),
    ),
  ]);
  const persistedByCodexId = latestPersistedSessionsByCodexId(persistedRecords);
  const sessionSettings = readAgentSessionSettings();
  const liveByCodexId = new Map();
  for (const live of sessions.values()) {
    if (live.hostId === agentHost.id && isValidSessionId(live.sessionId)) {
      liveByCodexId.set(live.sessionId, live);
    }
  }
  const relationFor = (threadId, thread = byId.get(threadId)?.thread) => {
    const live = liveByCodexId.get(threadId) || {};
    const saved = agentSessionSetting(sessionSettings, threadId, agentHost.id);
    const persisted = persistedByCodexId.get(threadId) || {};
    const file = fileRelations.get(threadId) || {};
    return {
      parentThreadId: firstValidThreadId(
        thread?.parentThreadId,
        live.parentThreadId,
        saved.parentThreadId,
        persisted.parentThreadId,
        file.parentThreadId,
      ),
      forkedFromId: firstValidThreadId(
        thread?.forkedFromId,
        live.forkedFromId,
        saved.forkedFromId,
        persisted.forkedFromId,
        file.forkedFromId,
      ),
    };
  };

  let ancestor = current;
  for (let depth = 0; ancestor && depth < 100; depth += 1) {
    const ancestorId = String(ancestor.id || "");
    const relation = relationFor(ancestorId, ancestor);
    const parentId = relation.parentThreadId || relation.forkedFromId;
    if (!parentId) break;
    let parent = byId.get(parentId)?.thread || null;
    if (!parent) {
      parent = await session.appServer.readThread({ threadId: parentId, includeTurns: false }).catch(() => null);
      if (parent?.id) byId.set(parent.id, { thread: parent, archived: false });
    }
    ancestor = parent;
  }

  const relatedIds = new Set();
  const pending = [session.sessionId];
  while (pending.length) {
    const id = pending.shift();
    if (!id || relatedIds.has(id)) continue;
    relatedIds.add(id);
    const entry = byId.get(id);
    const thread = entry?.thread;
    const relation = relationFor(id, thread);
    const parentId = relation.parentThreadId || relation.forkedFromId;
    if (parentId) pending.push(parentId);
    for (const candidate of byId.values()) {
      const candidateId = String(candidate.thread?.id || "");
      const candidateRelation = relationFor(candidateId, candidate.thread);
      const candidateParentId = candidateRelation.parentThreadId || candidateRelation.forkedFromId;
      if (candidateParentId === id) pending.push(String(candidate.thread?.id || ""));
    }
  }

  const nodes = [...relatedIds]
    .map((id) => {
      const entry = byId.get(id);
      const thread = entry?.thread;
      if (!thread) return null;
      const relation = relationFor(id, thread);
      const parentId = relation.parentThreadId || relation.forkedFromId;
      return {
        id,
        parentId: relatedIds.has(parentId) ? parentId : "",
        relation: relation.parentThreadId ? "agent" : relation.forkedFromId ? "branch" : "root",
        current: id === session.sessionId,
        archived: Boolean(entry.archived),
        name: cleanCustomTitle(thread.name) || cleanTitle(thread.preview) || "Untitled session",
        nickname: String(thread.agentNickname || ""),
        role: String(thread.agentRole || ""),
        status: threadStatusLabel(thread.status),
        statusType: String(thread.status?.type || ""),
        project: agentHostProject(
          resolveAgentHost(AGENT_HOSTS, session.hostId) || PERSONAL_AGENT_HOST,
          String(thread.cwd || ""),
        ),
        updatedAt: unixSecondsToIso(thread.updatedAt),
      };
    })
    .filter(Boolean);

  send(ws, "app-command-result", {
    kind: "thread-tree",
    title: "Session 关系",
    currentThreadId: session.sessionId,
    nodes,
    note: nodes.length > 1 ? "Agent 节点来自委派；“分支”节点来自 fork。" : "当前 Session 暂时没有分支或子 Agent。",
  });
}

function restoreSideChatState() {
  return {
    id: "",
    client: null,
    threadId: "",
    status: "closed",
    active: false,
    turnId: "",
    items: [],
    error: "",
    startedAt: "",
  };
}

function publicSideChatState(sideChat) {
  const state = sideChat || restoreSideChatState();
  return {
    id: String(state.id || ""),
    threadId: String(state.threadId || ""),
    status: String(state.status || "closed"),
    active: Boolean(state.active),
    turnId: String(state.turnId || ""),
    items: (Array.isArray(state.items) ? state.items : []).slice(-100).map((item) => ({
      id: String(item?.id || ""),
      role: item?.role === "assistant" ? "assistant" : item?.role === "notice" ? "notice" : "user",
      text: trimAppTranscriptValue(item?.text, 20_000),
      status: String(item?.status || ""),
    })),
    error: cleanClientLogValue(state.error, 1_000),
    startedAt: String(state.startedAt || ""),
  };
}

function broadcastSideChat(session) {
  broadcast(session, "side-chat-state", publicSideChatState(session.sideChat));
}

function sideChatInstructions(session) {
  const requirements = (session.turnState?.requirements || [])
    .filter((item) => ["working", "queued", "interrupted"].includes(item.status))
    .map((item) => `- ${item.text}`)
    .join("\n");
  return [
    AGENT_WEB_DEVELOPER_INSTRUCTIONS,
    "You are a temporary read-only side conversation forked from the user's main Codex thread.",
    "Answer the user's focused question. Do not edit files, run mutating commands, send messages, or make external changes.",
    "Keep the answer self-contained and concise. This side conversation is ephemeral and must not take ownership of the main task.",
    requirements ? `The main thread is currently working on these requirements for context only:\n${requirements}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function createSideChat(session) {
  if (session.sideChat?.client && !session.sideChat.client.closed) return session.sideChat;
  if (!session.ready || session.exited || !session.sessionId) throw new Error("当前 Session 还没有准备好。");

  const client = createAgentAppServerClient(
    session.cwd,
    `side-${session.id}-${cryptoRandomId()}`,
    {
      name: "agent_terminal_web_side_chat",
      title: "Agent Web Side Chat",
      version: "0.1.0",
    },
    resolveAgentHost(AGENT_HOSTS, session.hostId) || PERSONAL_AGENT_HOST,
  );
  const sideChat = {
    ...restoreSideChatState(),
    id: cryptoRandomId(),
    client,
    status: "starting",
    startedAt: new Date().toISOString(),
  };
  session.sideChat = sideChat;
  broadcastSideChat(session);

  client.on("notification", (message) => handleSideChatNotification(session, sideChat, message));
  client.on("server-request", (message) => declineSideChatRequest(sideChat, message));
  client.on("stderr", (text) => {
    logAgentEvent("side-chat-stderr", {
      webSessionId: session.id,
      message: cleanClientLogValue(text, 500),
    });
  });
  client.on("exit", (error) => {
    if (session.sideChat !== sideChat || sideChat.status === "closed") return;
    sideChat.active = false;
    sideChat.status = "failed";
    sideChat.error = error?.message || "临时侧问连接已关闭。";
    broadcastSideChat(session);
    resetDetachedCleanupAfterWork(session);
  });

  try {
    await client.start();
    const forkParams = {
      threadId: session.sessionId,
      cwd: session.cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      developerInstructions: sideChatInstructions(session),
      ephemeral: true,
      excludeTurns: true,
      deferGoalContinuation: true,
    };
    if (session.turnState.active && session.turnState.turnId) forkParams.beforeTurnId = session.turnState.turnId;
    const result = await client.forkThread(forkParams);
    sideChat.threadId = String(result?.thread?.id || client.threadId || "");
    if (!sideChat.threadId) throw new Error("Codex 没有返回临时对话 ID。");
    sideChat.status = "idle";
    broadcastSideChat(session);
    return sideChat;
  } catch (error) {
    sideChat.status = "failed";
    sideChat.error = error.message;
    broadcastSideChat(session);
    client.close();
    throw error;
  }
}

async function submitSideChatPrompt(session, text) {
  const sideChat = await createSideChat(session);
  if (sideChat.active || sideChat.client.activeTurnId) throw new Error("临时侧问仍在回答，请先等待或停止。");
  sideChat.error = "";
  sideChat.items.push({
    id: `side-user-${Date.now()}`,
    role: "user",
    text,
    status: "completed",
  });
  sideChat.active = true;
  sideChat.status = "working";
  broadcastSideChat(session);
  try {
    const turn = await sideChat.client.startTurn(text, {
      approvalPolicy: "never",
      cwd: session.cwd,
    });
    sideChat.turnId = String(turn?.id || sideChat.client.activeTurnId || "");
    broadcastSideChat(session);
    return { threadId: sideChat.threadId, turnId: sideChat.turnId };
  } catch (error) {
    sideChat.active = false;
    sideChat.status = "failed";
    sideChat.error = error.message;
    broadcastSideChat(session);
    throw error;
  }
}

function sideChatAssistantItem(sideChat, itemId) {
  const id = String(itemId || `side-assistant-${Date.now()}`);
  let item = sideChat.items.find((entry) => entry.id === id);
  if (!item) {
    item = { id, role: "assistant", text: "", status: "inProgress" };
    sideChat.items.push(item);
  }
  return item;
}

function handleSideChatNotification(session, sideChat, message) {
  if (session.sideChat !== sideChat || sideChat.status === "closed") return;
  const { method, params = {} } = message;
  const notificationThreadId = String(
    params.threadId || (method === "thread/started" ? params.thread?.id : "") || "",
  );
  if (notificationThreadId && sideChat.threadId && notificationThreadId !== sideChat.threadId) return;

  if (method === "turn/started") {
    sideChat.active = true;
    sideChat.status = "working";
    sideChat.turnId = String(params.turn?.id || "");
  } else if (method === "item/agentMessage/delta") {
    const item = sideChatAssistantItem(sideChat, params.itemId);
    item.text = trimAppTranscriptValue(`${item.text}${params.delta || ""}`, 20_000);
  } else if (method === "item/completed" && params.item?.type === "agentMessage") {
    const item = sideChatAssistantItem(sideChat, params.item.id);
    item.text = trimAppTranscriptValue(params.item.text || item.text, 20_000);
    item.status = "completed";
  } else if (method === "turn/completed") {
    sideChat.active = false;
    sideChat.turnId = "";
    sideChat.status = params.turn?.status === "failed" ? "failed" : "idle";
    if (params.turn?.error?.message) sideChat.error = params.turn.error.message;
    resetDetachedCleanupAfterWork(session);
  } else if (method === "error") {
    sideChat.active = false;
    sideChat.status = "failed";
    sideChat.error = params.error?.message || params.message || "临时侧问失败。";
    resetDetachedCleanupAfterWork(session);
  } else {
    return;
  }
  if (sideChat.items.length > 100) sideChat.items.splice(0, sideChat.items.length - 100);
  broadcastSideChat(session);
}

function declineSideChatRequest(sideChat, message) {
  const method = String(message?.method || "");
  try {
    if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
      sideChat.client.respond(message.id, { decision: "decline" });
    } else if (method === "item/permissions/requestApproval") {
      sideChat.client.respond(message.id, { permissions: {}, scope: "turn" });
    } else if (method === "mcpServer/elicitation/request") {
      sideChat.client.respond(message.id, { action: "decline" });
    } else if (method === "item/tool/requestUserInput") {
      const answers = {};
      for (const question of message.params?.questions || []) answers[question.id] = { answers: [""] };
      sideChat.client.respond(message.id, { answers });
    } else {
      sideChat.client.respondError(message.id, { code: -32000, message: "Side chat is read-only." });
    }
  } catch (error) {
    sideChat.error = error.message;
  }
}

async function stopSideChat(session) {
  const sideChat = session.sideChat;
  if (!sideChat?.client || !sideChat.active) return;
  sideChat.status = "stopping";
  broadcastSideChat(session);
  await sideChat.client.interruptTurn();
}

function closeSideChat(session) {
  const sideChat = session.sideChat;
  if (!sideChat) return;
  sideChat.status = "closed";
  sideChat.active = false;
  releaseAgentAppServerClient(sideChat.client, { interrupt: true });
  session.sideChat = null;
  broadcastSideChat(session);
}

function restoreRealtimeState() {
  return {
    status: "idle",
    voice: DEFAULT_REALTIME_V3_VOICE,
    version: "v3",
    transcript: [],
    error: "",
    reason: "",
    startedAt: "",
  };
}

function publicRealtimeState(realtime) {
  const state = realtime || restoreRealtimeState();
  return {
    status: String(state.status || "idle"),
    voice: normalizeRealtimeVoice(state.voice),
    version: String(state.version || "v3"),
    transcript: (Array.isArray(state.transcript) ? state.transcript : []).slice(-80).map((item) => ({
      id: String(item?.id || ""),
      role: String(item?.role || "assistant"),
      text: trimAppTranscriptValue(item?.text, 10_000),
      final: Boolean(item?.final),
    })),
    error: cleanClientLogValue(state.error, 1_000),
    reason: cleanClientLogValue(state.reason, 500),
    startedAt: String(state.startedAt || ""),
  };
}

function realtimeBusy(realtime) {
  return ["starting", "live", "stopping"].includes(String(realtime?.status || ""));
}

async function sendRealtimeVoices(session, ws) {
  send(ws, "realtime-voices", {
    voices: REALTIME_V3_VOICES,
    defaultVoice: DEFAULT_REALTIME_V3_VOICE,
    version: "v3",
  });
}

function normalizeRealtimeVoice(value) {
  const voice = String(value || "").trim();
  return REALTIME_V3_VOICES.includes(voice) ? voice : DEFAULT_REALTIME_V3_VOICE;
}

function normalizeRealtimeTransport(value) {
  const transport = value && typeof value === "object" ? value : {};
  if (transport.type !== "webrtc") {
    throw new Error("Agent Web 实时语音需要使用浏览器 WebRTC 连接。");
  }
  const sdp = String(transport.sdp || "");
  if (!sdp || sdp.length > REALTIME_SDP_MAX_CHARS || !/^v=0(?:\r?\n)/.test(sdp)) {
    throw new Error("浏览器实时语音连接信息无效。");
  }
  return { type: "webrtc", sdp };
}

async function startRealtimeConversation(session, { voice, transport } = {}) {
  if (!session.ready || session.exited) throw new Error("当前 Session 还没有准备好。");
  if (session.turnState.active || session.appServer.activeTurnId) {
    throw new Error("主 Session 仍在执行任务，请等当前 turn 完成后再开始实时对话。");
  }
  if (realtimeBusy(session.realtime)) throw new Error("实时对话已经在进行。");
  session.realtime = {
    ...restoreRealtimeState(),
    status: "starting",
    voice: normalizeRealtimeVoice(voice),
    startedAt: new Date().toISOString(),
  };
  broadcast(session, "realtime-state", publicRealtimeState(session.realtime));
  await session.appServer.startRealtime({
    version: "v3",
    voice: session.realtime.voice,
    outputModality: "audio",
    transport: normalizeRealtimeTransport(transport),
    includeStartupContext: true,
    flushTranscriptTailOnSessionEnd: true,
    codexResponsesAsItems: true,
  });
}

function normalizeRealtimeAudioChunk(value) {
  const input = value && typeof value === "object" ? value : {};
  const data = String(input.data || "");
  if (
    !data ||
    data.length > REALTIME_AUDIO_MAX_BASE64_CHARS ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error("实时音频块格式无效。");
  }
  const sampleRate = clampInteger(
    input.sampleRate,
    REALTIME_SAMPLE_RATE_MIN,
    REALTIME_SAMPLE_RATE_MAX,
    24_000,
  );
  const numChannels = clampInteger(input.numChannels, 1, 2, 1);
  const byteLength = Buffer.from(data, "base64").byteLength;
  if (!byteLength || byteLength % (2 * numChannels) !== 0) throw new Error("实时音频块不是有效的 PCM16 数据。");
  const samplesPerChannel = byteLength / 2 / numChannels;
  return {
    data,
    sampleRate,
    numChannels,
    samplesPerChannel,
    itemId: input.itemId ? String(input.itemId).slice(0, 200) : null,
  };
}

async function stopRealtimeConversation(session) {
  if (!realtimeBusy(session.realtime)) return;
  session.realtime.status = "stopping";
  broadcast(session, "realtime-state", publicRealtimeState(session.realtime));
  await session.appServer.stopRealtime();
}

function realtimeTranscriptItem(state, role) {
  const normalizedRole = role === "user" ? "user" : "assistant";
  let item = state.transcript.at(-1);
  if (!item || item.final || item.role !== normalizedRole) {
    item = {
      id: `realtime-${Date.now()}-${state.transcript.length + 1}`,
      role: normalizedRole,
      text: "",
      final: false,
    };
    state.transcript.push(item);
  }
  return item;
}

function handleRealtimeNotification(session, method, params) {
  if (!String(method || "").startsWith("thread/realtime/")) return false;
  if (params.threadId && session.sessionId && params.threadId !== session.sessionId) return true;
  const state = session.realtime || (session.realtime = restoreRealtimeState());

  if (method === "thread/realtime/started") {
    state.status = "live";
    state.version = String(params.version || "v3");
    state.error = "";
  } else if (method === "thread/realtime/transcript/delta") {
    const item = realtimeTranscriptItem(state, params.role);
    item.text = trimAppTranscriptValue(`${item.text}${params.delta || ""}`, 10_000);
  } else if (method === "thread/realtime/transcript/done") {
    const item = realtimeTranscriptItem(state, params.role);
    item.text = trimAppTranscriptValue(params.text || item.text, 10_000);
    item.final = true;
  } else if (method === "thread/realtime/outputAudio/delta") {
    try {
      broadcast(session, "realtime-audio", normalizeRealtimeAudioChunk(params.audio));
    } catch (error) {
      failRealtimeConversation(session, error);
    }
    return true;
  } else if (method === "thread/realtime/sdp") {
    const sdp = String(params.sdp || "");
    if (sdp && sdp.length <= REALTIME_SDP_MAX_CHARS) {
      broadcast(session, "realtime-sdp", { sdp });
    }
    return true;
  } else if (method === "thread/realtime/error") {
    state.status = "failed";
    state.error = params.message || "实时对话失败。";
    resetDetachedCleanupAfterWork(session);
  } else if (method === "thread/realtime/closed") {
    state.status = "idle";
    state.reason = String(params.reason || "");
    resetDetachedCleanupAfterWork(session);
  } else if (method !== "thread/realtime/itemAdded") {
    return false;
  } else {
    return true;
  }

  if (state.transcript.length > 80) state.transcript.splice(0, state.transcript.length - 80);
  broadcast(session, "realtime-state", publicRealtimeState(state));
  if (method === "thread/realtime/error") {
    broadcast(session, "realtime-error", { message: state.error });
  }
  return true;
}

function failRealtimeConversation(session, error) {
  const state = session.realtime || (session.realtime = restoreRealtimeState());
  state.status = "failed";
  state.error = error?.message || String(error || "实时对话失败。");
  broadcast(session, "realtime-state", publicRealtimeState(state));
  broadcast(session, "realtime-error", { message: state.error });
  resetDetachedCleanupAfterWork(session);
}

function branchThreadTitle(sourceTitle, suffix) {
  const base = cleanCustomTitle(sourceTitle) || "Codex Session";
  return cleanCustomTitle(`${base} · ${suffix}`);
}

async function rememberSessionTitle(
  threadId,
  title,
  agentHost = PERSONAL_AGENT_HOST,
) {
  if (agentHost.type !== "local") return;
  const cleaned = cleanCustomTitle(title);
  if (!threadId || !cleaned) return;
  const titles = await readSessionTitles();
  titles[threadId] = cleaned;
  await writeSessionTitles(titles);
}

function appTranscriptItemsFromTurns(session, turns, { historical = false } = {}) {
  const items = [];

  for (const turn of turns) {
    const context = {
      turnId: String(turn?.id || ""),
      turnStartedAt: Number.isFinite(turn?.startedAt) ? turn.startedAt : null,
      turnStatus: String(turn?.status || ""),
      historical,
    };
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      rememberToolMemoryCitation(session, item, context.turnId);
      rememberCollabAgentMetadata(session, item);
      const transcriptItem = appTranscriptFromThreadItem(session, item, context);
      if (transcriptItem) items.push(transcriptItem);
    }
  }
  return items;
}

function upsertAppTranscriptItem(session, item, { notify = true } = {}) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id || `app-item-${++session.appTranscriptSequence}`);
  const existingIndex = session.appTranscript.findIndex((entry) => entry.id === id);
  const existing = existingIndex >= 0 ? session.appTranscript[existingIndex] : null;
  const normalized = normalizeAppTranscriptItem({ ...existing, ...item, id });
  if (existingIndex >= 0) {
    session.appTranscript[existingIndex] = normalized;
  } else {
    session.appTranscript.push(normalized);
    if (session.appTranscript.length > MAX_APP_TRANSCRIPT_ITEMS) {
      session.appTranscript.splice(0, session.appTranscript.length - MAX_APP_TRANSCRIPT_ITEMS);
    }
  }
  if (notify) broadcast(session, "app-transcript-upsert", normalized);
  return normalized;
}

function appendAppTranscriptDelta(session, itemId, field, delta, fallback = {}) {
  if (!delta || !["text", "detail", "output"].includes(field)) return;
  const id = String(itemId || fallback.id || `app-item-${++session.appTranscriptSequence}`);
  const existing = session.appTranscript.find((entry) => entry.id === id);
  if (!existing) upsertAppTranscriptItem(session, { ...fallback, id }, { notify: true });
  const current = session.appTranscript.find((entry) => entry.id === id);
  if (!current) return;
  current[field] = trimAppTranscriptValue(`${current[field] || ""}${delta}`, appTranscriptFieldLimit(field));
  broadcast(session, "app-transcript-delta", { id, field, delta: String(delta) });
}

function appendAppTranscriptNotice(session, text, tone = "warning") {
  if (!text) return;
  upsertAppTranscriptItem(session, {
    id: `notice-${++session.appTranscriptSequence}`,
    type: "notice",
    label: tone === "error" ? "错误" : tone === "warning" ? "提醒" : "状态",
    text,
    tone,
    turnId: session.turnState.turnId || "",
  });
}

function normalizeAppTranscriptItem(item) {
  return {
    id: String(item.id || ""),
    type: String(item.type || "notice"),
    label: String(item.label || "状态"),
    text: trimAppTranscriptValue(item.text, MAX_APP_TRANSCRIPT_TEXT),
    detail: trimAppTranscriptValue(item.detail, MAX_APP_TRANSCRIPT_DETAIL),
    output: trimAppTranscriptValue(item.output, MAX_APP_TRANSCRIPT_OUTPUT),
    status: String(item.status || ""),
    tone: String(item.tone || ""),
    phase: String(item.phase || ""),
    durationMs: Number.isFinite(item.durationMs) ? item.durationMs : null,
    exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null,
    turnId: String(item.turnId || ""),
    turnStartedAt: Number.isFinite(item.turnStartedAt) ? item.turnStartedAt : null,
    turnStatus: String(item.turnStatus || ""),
    historical: Boolean(item.historical),
    agentThreadId: String(item.agentThreadId || ""),
    agentPath: String(item.agentPath || ""),
    activityKind: String(item.activityKind || ""),
    attachments: normalizeTranscriptAttachments(item.attachments),
    memoryCitation: normalizeMemoryCitation(item.memoryCitation),
  };
}

function normalizeTranscriptAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : [])
    .slice(0, 10)
    .map((attachment) => ({
      path: trimAppTranscriptValue(attachment?.path, 2_000),
      originalName: trimAppTranscriptValue(attachment?.originalName || attachment?.name || "附件", 300),
      mime: trimAppTranscriptValue(attachment?.mime || "application/octet-stream", 200),
      size: Number.isFinite(attachment?.size) ? attachment.size : null,
    }))
    .filter((attachment) => attachment.path);
}

function normalizeMemoryCitation(citation) {
  if (!citation || typeof citation !== "object") return null;
  const entries = (Array.isArray(citation.entries) ? citation.entries : [])
    .slice(0, 30)
    .map((entry) => ({
      path: trimAppTranscriptValue(entry?.path, 2_000),
      lineStart: Number.isFinite(entry?.lineStart) ? entry.lineStart : null,
      lineEnd: Number.isFinite(entry?.lineEnd) ? entry.lineEnd : null,
      note: trimAppTranscriptValue(entry?.note, 4_000),
    }))
    .filter((entry) => entry.path || entry.note);
  const threadIds = (Array.isArray(citation.threadIds) ? citation.threadIds : [])
    .map((threadId) => String(threadId || "").slice(0, 200))
    .filter(Boolean)
    .slice(0, 30);
  return entries.length || threadIds.length ? { entries, threadIds } : null;
}

function appTranscriptFromThreadItem(session, item, context = {}) {
  if (!item || typeof item !== "object") return null;
  const base = { id: item.id, ...context };
  if (item.type === "userMessage") {
    const message = appServerUserMessageContent(session, item.content);
    return { ...base, type: "user", label: "你", text: message.text, attachments: message.attachments };
  }
  if (item.type === "agentMessage") {
    const turnId = String(context.turnId || session.turnState.turnId || "");
    return {
      ...base,
      type: "assistant",
      label: "Codex",
      text: item.text || "",
      phase: item.phase || "",
      memoryCitation: mergeMemoryCitations(
        item.memoryCitation,
        session.personalMemoryCitationsByTurn?.get(turnId),
      ),
    };
  }
  if (item.type === "plan") {
    return { ...base, type: "plan", label: "计划", text: item.text || "", status: item.status || "" };
  }
  if (item.type === "commandExecution") {
    return {
      ...base,
      type: "command",
      label: "命令",
      text: appServerCommandText(item) || "运行命令",
      detail: item.cwd ? `目录：${item.cwd}` : "",
      output: item.aggregatedOutput || "",
      status: item.status || "",
      durationMs: item.durationMs,
      exitCode: item.exitCode,
    };
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      ...base,
      type: "file",
      label: "文件修改",
      text: changes.length ? changes.map(appServerFileChangeText).join("\n") : "正在修改文件",
      status: item.status || "",
    };
  }
  if (item.type === "dynamicToolCall" && appServerToolLeafName(item) === "exec") return null;
  if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
    const name = appServerToolName(item);
    return {
      ...base,
      type: "tool",
      label: item.type === "collabAgentToolCall" ? "协作" : "工具",
      text: name,
      detail: appServerArgumentsText(item.arguments) || item.prompt || "",
      output: appServerToolResultText(item),
      status: item.status || (item.success === false ? "failed" : ""),
      durationMs: item.durationMs,
    };
  }
  if (item.type === "subAgentActivity") {
    return {
      ...base,
      type: "tool",
      label: "协作",
      text: `${item.agentPath || "子 Agent"} · ${item.kind || "activity"}`,
      agentThreadId: item.agentThreadId || "",
      agentPath: item.agentPath || "",
      activityKind: item.kind || "",
    };
  }
  if (item.type === "webSearch") {
    return { ...base, type: "tool", label: "网页搜索", text: item.query || "搜索网页" };
  }
  if (item.type === "imageView") {
    return { ...base, type: "tool", label: "查看图片", text: item.path || "图片" };
  }
  if (item.type === "imageGeneration") {
    return { ...base, type: "tool", label: "生成图片", text: item.status || "图片生成" };
  }
  if (item.type === "enteredReviewMode") {
    return { ...base, type: "notice", label: "状态", text: "已进入代码审查模式", tone: "info" };
  }
  if (item.type === "exitedReviewMode") {
    return { ...base, type: "notice", label: "状态", text: "已结束代码审查模式", tone: "info" };
  }
  return null;
}

function rememberToolMemoryCitation(session, item, turnId) {
  const id = String(turnId || "");
  if (!id) return;
  const citation = memoryCitationFromToolItem(item, {
    memoryRoot: path.join(OBSIDIAN_VAULT_ROOT, "System", "Memory"),
    workspaceRoot: WORKSPACE_ROOT,
  });
  if (!citation) return;
  session.personalMemoryCitationsByTurn.set(
    id,
    mergeMemoryCitations(session.personalMemoryCitationsByTurn.get(id), citation),
  );
}

function appServerUserMessageContent(session, content) {
  if (!Array.isArray(content)) return { text: "", attachments: [] };
  const text = [];
  const attachments = [];
  for (const entry of content) {
    if (typeof entry === "string") text.push(entry);
    else if (entry?.type === "text" && entry.text) text.push(entry.text);
    else if (entry?.type === "image" && entry.url) text.push(`图片：${entry.url}`);
    else if (["localImage", "localAudio", "mention"].includes(entry?.type) && entry.path) {
      attachments.push(appServerMessageAttachment(session, entry));
    } else if (entry?.type === "skill") text.push(`Skill：${entry.name || entry.path || ""}`);
  }
  return { text: text.filter(Boolean).join("\n"), attachments };
}

async function sessionShareSnapshot(session) {
  return sessionShareSnapshotFromAppServer(session.appServer, {
    threadId: session.sessionId,
    transcript: session.appTranscript,
    webSessionId: session.id,
    hostId: session.hostId || PERSONAL_AGENT_HOST.id,
  });
}

async function sessionShareSnapshotFromStoredThread(agentHost, sessionId) {
  return withStandaloneAppServer(agentHost, async (client) => {
    const thread = await client.readThread({ threadId: sessionId, includeTurns: false });
    if (!thread) throw new Error("Codex Session not found.");
    return {
      title: cleanCustomTitle(thread.name) || cleanTitle(thread.preview) || "Untitled session",
      snapshot: await sessionShareSnapshotFromAppServer(client, {
        threadId: sessionId,
        hostId: agentHost.id,
      }),
    };
  });
}

async function sessionShareSnapshotFromAppServer(
  appServer,
  { threadId, transcript = [], webSessionId = "", hostId = PERSONAL_AGENT_HOST.id } = {},
) {
  const candidates = new Map();
  let sequence = 0;
  let cursor = null;
  let scannedTurns = 0;
  let pageTruncated = false;

  try {
    const turnsById = new Map();
    do {
      const page = await appServer.listThreadTurns({
        threadId,
        limit: SESSION_SHARE_PAGE_LIMIT,
        cursor,
        sortDirection: "desc",
        itemsView: "full",
      });
      const turns = Array.isArray(page?.data) ? page.data : [];
      for (const turn of turns) {
        const turnId = String(turn?.id || "");
        if (turnId) turnsById.set(turnId, turn);
      }
      scannedTurns += turns.length;
      cursor = page?.nextCursor || null;
      if (!turns.length) break;
    } while (cursor && scannedTurns < SESSION_SHARE_MAX_TURNS);
    pageTruncated = Boolean(cursor);

    const turns = [...turnsById.values()].sort(
      (left, right) => Number(left?.startedAt || 0) - Number(right?.startedAt || 0),
    );
    for (const turn of turns) {
      const turnStartedAt = Number.isFinite(turn?.startedAt) ? turn.startedAt : null;
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        const candidate = sessionShareCandidateFromThreadItem(item, turnStartedAt, sequence++);
        if (candidate) candidates.set(candidate.sourceId, candidate);
      }
    }
  } catch (error) {
    logAgentEvent("session-share-history-fallback", {
      webSessionId,
      hostId,
      codexSessionId: threadId,
      message: cleanClientLogValue(error.message, 300),
    });
    if (!transcript.length) throw error;
  }

  for (const item of transcript) {
    const candidate = sessionShareCandidateFromTranscriptItem(item, sequence++);
    if (candidate) candidates.set(candidate.sourceId, candidate);
  }

  const ordered = [...candidates.values()]
    .sort((left, right) => {
      const leftTime = left.turnStartedAt ?? Number.MAX_SAFE_INTEGER;
      const rightTime = right.turnStartedAt ?? Number.MAX_SAFE_INTEGER;
      return leftTime === rightTime ? left.sequence - right.sequence : leftTime - rightTime;
    })
    .map(({ role, text }) => ({ role, text }));
  const messages = normalizeShareMessages(ordered);
  return {
    messages,
    truncated: pageTruncated || Boolean(messages.truncated),
  };
}

function sessionShareCandidateFromThreadItem(item, turnStartedAt, sequence) {
  if (!item || typeof item !== "object") return null;
  if (item.type === "userMessage") {
    const text = sessionShareUserText(item.content);
    return text
      ? {
          sourceId: String(item.id || `share-user-${sequence}`),
          role: "user",
          text,
          turnStartedAt,
          sequence,
        }
      : null;
  }
  if (item.type !== "agentMessage" || !["", "final_answer"].includes(String(item.phase || ""))) {
    return null;
  }
  const text = String(item.text || "").trim();
  return text
    ? {
        sourceId: String(item.id || `share-assistant-${sequence}`),
        role: "assistant",
        text,
        turnStartedAt,
        sequence,
      }
    : null;
}

function sessionShareCandidateFromTranscriptItem(item, sequence) {
  const role =
    item?.type === "user"
      ? "user"
      : item?.type === "assistant" && ["", "final_answer"].includes(String(item.phase || ""))
        ? "assistant"
        : "";
  const text = String(item?.text || "").trim();
  if (!role || !text) return null;
  return {
    sourceId: String(item.id || `share-live-${sequence}`),
    role,
    text,
    turnStartedAt: Number.isFinite(item.turnStartedAt) ? item.turnStartedAt : null,
    sequence,
  };
}

function sessionShareUserText(content) {
  return (Array.isArray(content) ? content : [])
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (entry?.type === "text" && entry.text) return [entry.text];
      return [];
    })
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function appServerMessageAttachment(session, entry) {
  const remembered = session.submittedAttachmentMetadata?.get(entry.path);
  if (remembered) return { ...remembered };
  let size = null;
  try {
    const stat = fsSync.statSync(entry.path);
    if (stat.isFile()) size = stat.size;
  } catch {
    size = null;
  }
  return {
    path: String(entry.path),
    originalName: cleanUploadOriginalName(entry.name || path.basename(entry.path)),
    mime:
      entry.type === "localImage"
        ? "image/*"
        : entry.type === "localAudio"
          ? "audio/*"
          : "application/octet-stream",
    size,
  };
}

function appServerFileChangeText(change) {
  const kind = change?.kind?.type || change?.kind || "update";
  const labels = { add: "新增", create: "新增", delete: "删除", update: "修改", modify: "修改", move: "移动" };
  return `${labels[kind] || kind} · ${change?.path || "文件"}`;
}

function appServerArgumentsText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function appTranscriptFieldLimit(field) {
  if (field === "output") return MAX_APP_TRANSCRIPT_OUTPUT;
  if (field === "detail") return MAX_APP_TRANSCRIPT_DETAIL;
  return MAX_APP_TRANSCRIPT_TEXT;
}

function trimAppTranscriptValue(value, limit) {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.65);
  const tailLength = limit - headLength;
  return `${text.slice(0, headLength)}\n\n… 中间内容已折叠 …\n\n${text.slice(-tailLength)}`;
}

function handleAppServerNotification(session, message) {
  if (session.exited) return;
  const { method, params = {} } = message;

  if (handleRealtimeNotification(session, method, params)) return;
  const notificationThreadId = String(
    params.threadId || (method === "thread/started" ? params.thread?.id : "") || "",
  );
  if (notificationThreadId && session.sessionId && notificationThreadId !== session.sessionId) return;
  if (notificationThreadId) session.lastActivityAt = new Date().toISOString();

  if (method === "thread/started" && params.thread?.id) {
    session.sessionId = params.thread.id;
    rememberAgentSessionAccess(session.sessionId, session.access, session.hostId);
  }
  if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
    session.appTokenUsage = params.tokenUsage;
    broadcast(session, "status", publicSession(session));
  }
  if (method === "turn/started") {
    session.turnInterruptPending = false;
    session.turnState.active = true;
    session.turnState.stopping = false;
    session.turnState.interrupted = false;
    session.turnState.interruptedAt = "";
    session.turnState.turnId = params.turn?.id || "";
    const pendingMemory = session.pendingPersonalMemoryCitations.shift();
    if (pendingMemory?.citation && session.turnState.turnId) {
      session.personalMemoryCitationsByTurn.set(session.turnState.turnId, pendingMemory.citation);
    }
    appendSessionOutput(session, "\r\n\x1b[34m── Turn started ──\x1b[0m\r\n");
  } else if (method === "item/agentMessage/delta") {
    if (params.itemId) session.streamedItemIds.add(params.itemId);
    appendAppTranscriptDelta(session, params.itemId, "text", params.delta || "", {
      type: "assistant",
      label: "Codex",
      turnId: params.turnId || session.turnState.turnId,
    });
    appendSessionOutput(session, params.delta || "");
  } else if (method === "item/commandExecution/outputDelta") {
    if (params.itemId) session.streamedItemIds.add(params.itemId);
    appendAppTranscriptDelta(session, params.itemId, "output", params.delta || "", {
      type: "command",
      label: "命令",
      text: "运行命令",
      status: "inProgress",
      turnId: params.turnId || session.turnState.turnId,
    });
    appendSessionOutput(session, params.delta || "");
  } else if (method === "item/fileChange/outputDelta") {
    if (params.itemId) session.streamedItemIds.add(params.itemId);
    appendAppTranscriptDelta(session, params.itemId, "output", params.delta || "", {
      type: "file",
      label: "文件修改",
      text: "正在修改文件",
      status: "inProgress",
      turnId: params.turnId || session.turnState.turnId,
    });
    appendSessionOutput(session, params.delta || "");
  } else if (method === "item/reasoning/summaryTextDelta") {
    appendSessionOutput(session, `\x1b[2m${params.delta || ""}\x1b[0m`);
  } else if (method === "turn/plan/updated") {
    renderAppServerPlanUpdate(session, params);
  } else if (method === "item/mcpToolCall/progress") {
    if (params.message) {
      appendAppTranscriptDelta(session, params.itemId, "detail", `${params.message}\n`, {
        type: "tool",
        label: "工具",
        text: "正在使用工具",
        status: "inProgress",
        turnId: params.turnId || session.turnState.turnId,
      });
      appendSessionOutput(session, `\r\n\x1b[2m${params.message}\x1b[0m\r\n`);
    }
  } else if (["warning", "guardianWarning", "windows/worldWritableWarning"].includes(method)) {
    const warning = params.message || "App Server warning";
    appendAppTranscriptNotice(session, warning, "warning");
    appendSessionOutput(session, `\r\n\x1b[33mWarning: ${warning}\x1b[0m\r\n`);
  } else if (method === "configWarning") {
    const warning = [params.summary, params.details, params.path].filter(Boolean).join(" · ");
    appendAppTranscriptNotice(session, warning || "请检查 Codex 配置。", "warning");
    appendSessionOutput(session, `\r\n\x1b[33mConfig warning: ${warning || "Check Codex configuration."}\x1b[0m\r\n`);
  } else if (method === "model/rerouted") {
    appendAppTranscriptNotice(
      session,
      `模型已切换：${params.fromModel || "请求的模型"} → ${params.toModel || "备用模型"}`,
      "warning",
    );
    appendSessionOutput(
      session,
      `\r\n\x1b[33mModel changed: ${params.fromModel || "requested model"} → ${params.toModel || "fallback model"}.\x1b[0m\r\n`,
    );
  } else if (method === "item/started") {
    rememberCollabAgentMetadata(session, params.item);
    const transcriptItem = appTranscriptFromThreadItem(session, params.item, {
      turnId: params.turnId || session.turnState.turnId,
    });
    if (transcriptItem) upsertAppTranscriptItem(session, transcriptItem);
    renderAppServerItemStarted(session, params.item);
  } else if (method === "item/completed") {
    rememberToolMemoryCitation(session, params.item, params.turnId || session.turnState.turnId);
    rememberCollabAgentMetadata(session, params.item);
    const transcriptItem = appTranscriptFromThreadItem(session, params.item, {
      turnId: params.turnId || session.turnState.turnId,
    });
    if (transcriptItem) upsertAppTranscriptItem(session, transcriptItem);
    renderAppServerItemCompleted(session, params.item);
  } else if (method === "turn/completed") {
    const turnId = cleanTurnId(params.turn?.id);
    const turnStatus = String(params.turn?.status || "").toLowerCase();
    const stopped = Boolean(
      ["interrupted", "cancelled", "canceled"].includes(turnStatus) ||
        (session.turnState.stopping && (!turnId || !session.turnState.turnId || turnId === session.turnState.turnId)),
    );
    if (!stopped) persistCompletedSessionPreview(session, session.lastAssistantMessage);
    completeTrackedTurn(session, turnId, { stopped });
    if (!stopped) {
      rememberAgentSessionCompletion(
        session.sessionId,
        turnId,
        session.lastActivityAt,
        session.hostId,
      );
    }
    if (turnId) session.personalMemoryCitationsByTurn.delete(turnId);
    session.turnInterruptPending = false;
    resetDetachedCleanupAfterWork(session);
    appendSessionOutput(
      session,
      stopped ? "\r\n\x1b[33m■ Turn stopped\x1b[0m\r\n" : "\r\n\x1b[32m✓ Turn completed\x1b[0m\r\n",
    );
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
    scheduleSessionProcessIndexWarm(session);
    if (!stopped) {
      if (session.hostId === PERSONAL_AGENT_HOST.id) {
        personalMemoryScheduler.schedule(session.sessionId || session.id);
      }
      void sendAppServerTurnNotification(session, turnId);
    }
  } else if (method === "error") {
    const errorMessage = params.error?.message || params.message || "App Server error";
    appendAppTranscriptNotice(session, errorMessage, "error");
    appendSessionOutput(session, `\r\n\x1b[31m${errorMessage}\x1b[0m\r\n`);
  } else if (method === "serverRequest/resolved") {
    const requestId = String(params.requestId ?? "");
    if (requestId) session.pendingServerRequests.delete(requestId);
    broadcast(session, "agent-request-resolved", { requestId });
  }

  if (["thread/started", "turn/started", "turn/completed", "error"].includes(method)) {
    persistRestorableWebSession(session);
    broadcast(session, "status", publicSession(session));
  }
}

function renderAppServerItemStarted(session, item) {
  if (!item || typeof item !== "object") return;
  if (item.type === "commandExecution") {
    const command = appServerCommandText(item);
    appendSessionOutput(session, `\r\n\x1b[33m$ ${command || "Running command"}\x1b[0m\r\n`);
  } else if (item.type === "fileChange") {
    appendSessionOutput(session, "\r\n\x1b[35mApplying file changes…\x1b[0m\r\n");
  } else if (["mcpToolCall", "dynamicToolCall", "collabAgentToolCall"].includes(item.type)) {
    appendSessionOutput(session, `\r\n\x1b[36mUsing ${item.server || item.tool || item.type}…\x1b[0m\r\n`);
  }
}

function renderAppServerItemCompleted(session, item) {
  if (!item || typeof item !== "object") return;
  if (item.type === "agentMessage") {
    if (!session.streamedItemIds.has(item.id) && item.text) appendSessionOutput(session, item.text);
    session.streamedItemIds.delete(item.id);
    if (item.phase === "final_answer") session.lastAssistantMessage = item.text || session.lastAssistantMessage;
    appendSessionOutput(session, "\r\n");
  } else if (item.type === "plan") {
    if (item.text) appendSessionOutput(session, `\r\n\x1b[36mPlan\x1b[0m\r\n${item.text}\r\n`);
  } else if (item.type === "commandExecution") {
    const streamed = session.streamedItemIds.has(item.id);
    const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
    if (!streamed && output) {
      appendSessionOutput(session, output);
      if (!output.endsWith("\n")) appendSessionOutput(session, "\r\n");
    }
    session.streamedItemIds.delete(item.id);
    const code = item.exitCode ?? item.exit_code;
    const duration = Number.isFinite(item.durationMs) ? ` · ${formatDuration(item.durationMs)}` : "";
    if (code !== undefined && code !== null) {
      appendSessionOutput(session, `\r\n\x1b[2mCommand exited ${code}${duration}.\x1b[0m\r\n`);
    }
  } else if (item.type === "fileChange") {
    session.streamedItemIds.delete(item.id);
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const detail = changes
      .map((change) => {
        const kind = change?.kind?.type || change?.kind || "update";
        return `  ${kind} ${change?.path || "file"}`;
      })
      .join("\r\n");
    appendSessionOutput(
      session,
      `\r\n\x1b[35mFiles updated${changes.length ? ` (${changes.length})` : ""}.\x1b[0m${detail ? `\r\n${detail}` : ""}\r\n`,
    );
  } else if (["mcpToolCall", "dynamicToolCall"].includes(item.type)) {
    const result = appServerToolResultText(item);
    if (result) appendSessionOutput(session, `${result}${result.endsWith("\n") ? "" : "\r\n"}`);
    if (item.error?.message) appendSessionOutput(session, `\x1b[31m${item.error.message}\x1b[0m\r\n`);
    const label = item.tool || item.type;
    appendSessionOutput(session, `\x1b[2m${label} ${item.status || "completed"}.\x1b[0m\r\n`);
  }
}

function renderAppServerPlanUpdate(session, params) {
  const plan = Array.isArray(params.plan) ? params.plan : [];
  const signature = JSON.stringify({ explanation: params.explanation || "", plan });
  if (!plan.length || signature === session.lastPlanSignature) return;
  session.lastPlanSignature = signature;
  const marks = { completed: "✓", inProgress: "→", pending: "○" };
  const lines = plan.map((item) => `${marks[item.status] || "○"} ${item.step || ""}`);
  const explanation = params.explanation ? `${params.explanation}\r\n` : "";
  upsertAppTranscriptItem(session, {
    id: `plan-${params.turnId || session.turnState.turnId || "current"}`,
    type: "plan",
    label: "计划",
    text: `${params.explanation ? `${params.explanation}\n` : ""}${lines.join("\n")}`,
    status: plan.some((item) => item.status === "inProgress") ? "inProgress" : "completed",
    turnId: params.turnId || session.turnState.turnId,
  });
  appendSessionOutput(session, `\r\n\x1b[36mPlan updated\x1b[0m\r\n${explanation}${lines.join("\r\n")}\r\n`);
}

function appServerToolResultText(item) {
  const content = item.result?.content || item.contentItems;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (typeof entry?.text === "string") return entry.text;
      return "";
    })
    .filter(Boolean)
    .join("\r\n");
}

function formatDuration(durationMs) {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function appServerCommandText(item) {
  return commandDisplayText(item.cmd || item.command);
}

function appServerToolName(item) {
  return [item.server, item.namespace, item.tool].filter(Boolean).join(" · ") || "工具";
}

function appServerToolLeafName(item) {
  return String(item.tool || item.namespace || item.server || "");
}

function handleAppServerRequest(session, message) {
  const requestId = String(message.id ?? "");
  if (!requestId) return;
  session.lastActivityAt = new Date().toISOString();
  session.pendingServerRequests.set(requestId, message);
  persistRestorableWebSession(session);
  broadcast(session, "status", publicSession(session));
  broadcast(session, "agent-request", publicAppServerRequest(message));
}

function publicAppServerRequest(message) {
  const params = message.params || {};
  const method = message.method || "";
  if (method === "item/commandExecution/requestApproval") {
    return {
      requestId: String(message.id),
      method,
      kind: "approval",
      title: "运行命令？",
      detail: [params.command, params.reason].filter(Boolean).join("\n\n"),
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      requestId: String(message.id),
      method,
      kind: "approval",
      title: "允许修改文件？",
      detail: params.reason || params.grantRoot || "Codex 请求写入文件。",
    };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      requestId: String(message.id),
      method,
      kind: "approval",
      title: "允许额外权限？",
      detail: params.reason || JSON.stringify(params.permissions || {}, null, 2),
    };
  }
  if (method === "item/tool/requestUserInput") {
    return {
      requestId: String(message.id),
      method,
      kind: "question",
      title: params.questions?.[0]?.header || "Codex 需要你的回答",
      detail: (params.questions || []).map((question) => question.question).join("\n"),
      questions: params.questions || [],
    };
  }
  return {
    requestId: String(message.id),
    method,
    kind: "unsupported",
    title: "Codex 需要确认",
    detail: cleanClientLogValue(params.message || method, 1_000),
  };
}

function handleAppServerResponse(session, message) {
  const requestId = String(message.requestId || "");
  const request = session.pendingServerRequests.get(requestId);
  if (!request) throw new Error("This App Server request is no longer pending.");
  const decision = ["accept", "acceptForSession", "decline", "cancel"].includes(message.decision)
    ? message.decision
    : "decline";
  let result;

  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(request.method)) {
    result = { decision };
  } else if (request.method === "item/permissions/requestApproval") {
    result = {
      permissions: decision.startsWith("accept") ? request.params?.permissions || {} : {},
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  } else if (request.method === "item/tool/requestUserInput") {
    const answers = {};
    for (const question of request.params?.questions || []) {
      const value = message.answers?.[question.id] ?? message.answer ?? "";
      answers[question.id] = { answers: Array.isArray(value) ? value : [String(value)] };
    }
    result = { answers };
  } else if (request.method === "mcpServer/elicitation/request") {
    result = { action: decision.startsWith("accept") ? "accept" : decision === "cancel" ? "cancel" : "decline" };
  } else {
    session.appServer.respondError(request.id, { code: -32000, message: "Unsupported request in Agent Terminal Web." });
    session.pendingServerRequests.delete(requestId);
    broadcast(session, "agent-request-resolved", { requestId });
    return;
  }

  session.appServer.respond(request.id, result);
  session.pendingServerRequests.delete(requestId);
  broadcast(session, "agent-request-resolved", { requestId });
}

async function sendAppServerTurnNotification(session, turnId) {
  try {
    const result = await sendHomeTurnNotification(session, {
      type: "agent-turn-complete",
      "thread-id": session.sessionId,
      "turn-id": turnId,
      "last-assistant-message": session.lastAssistantMessage,
    });
    logAgentEvent("turn-notification", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      turnId,
      sent: result.sent,
      subscriptionCount: result.subscriptionCount,
      transport: APP_SERVER_TRANSPORT,
    });
  } catch (error) {
    logAgentEvent("turn-notification-failed", {
      webSessionId: session.id,
      codexSessionId: session.sessionId,
      message: error.message,
      transport: APP_SERVER_TRANSPORT,
    });
  }
}

function markAppServerExited(session, error) {
  if (session.exited) return;
  if (session.runtimeLeaseTimer) {
    clearTimeout(session.runtimeLeaseTimer);
    session.runtimeLeaseTimer = null;
  }
  closeSideChat(session);
  session.realtime = { ...restoreRealtimeState(), status: "failed", error: error?.message || "App Server 已关闭。" };
  session.ready = false;
  session.exited = true;
  session.exitCode = 1;
  session.signal = null;
  if (session.sessionId) {
    session.turnState = interruptedTurnStateAfterProcessLoss(session.turnState);
    persistWebSession(session);
  } else {
    removePersistedWebSession(session.id);
  }
  logAgentEvent("app-server-exit", {
    webSessionId: session.id,
    codexSessionId: session.sessionId,
    message: error?.message || "",
  });
  broadcast(session, "status", publicSession(session));
  for (const client of session.clients) client.close();
  scheduleCleanup(session);
}

function appendSessionOutput(session, raw) {
  if (!raw) return;
  const revision = appendBuffers(session, raw);
  broadcast(session, "output", { raw, revision });
}

function submitTrackedPrompt(session, text, requestedMode, requirementText = text) {
  const state = session.turnState;
  const wantsQueue = requestedMode === "queue";

  if (!state.active) {
    state.sequence += 1;
    state.active = true;
    state.stopping = false;
    state.interrupted = false;
    state.interruptedAt = "";
    state.turnId = "";
    state.requirements = [turnRequirement(state, requirementText, "original", "working")];
    writeAndSubmit(session, text, { paste: true });
    return { deliveryMode: "new" };
  }

  if (wantsQueue) {
    const requirement = turnRequirement(state, requirementText, "queued", "queued");
    state.queuedTurns.push(requirement);
    trimTrackedRequirements(state);
    writeAndSubmit(session, queuePromptText(text), { paste: true, submitKey: "\t" });
    return { deliveryMode: "queue" };
  }

  const requirement = turnRequirement(state, requirementText, "followup", "working");
  state.requirements.push(requirement);
  trimTrackedRequirements(state);
  writeAndSubmit(session, steerPromptText(text, state.requirements.length), { paste: true });
  return { deliveryMode: "steer" };
}

function prepareSessionPrompt(session, text) {
  if (session.purpose !== THINK_SESSION_PURPOSE || session.thinkSkillActivated || session.thinkSkillActivationPending) {
    return { text, activatesThink: false };
  }

  const hasExplicitInvocation = text === THINKING_SKILL_INVOCATION || text.startsWith(`${THINKING_SKILL_INVOCATION}\n`);
  return {
    text: hasExplicitInvocation ? text : `${THINKING_SKILL_INVOCATION}\n\n${text}`,
    activatesThink: true,
  };
}

function completeTrackedTurn(session, turnId, { stopped = false } = {}) {
  const state = session.turnState;
  if (!state) return;
  if (turnId && turnId === state.lastCompletedTurnId) return;
  state.lastCompletedTurnId = turnId || state.lastCompletedTurnId;
  state.turnId = turnId || state.turnId;
  state.stopping = false;
  if (stopped) state.lastStoppedTurnId = turnId || state.turnId;
  state.interrupted = false;
  state.interruptedAt = "";
  for (const requirement of state.requirements) requirement.status = stopped ? "cancelled" : "completed";

  const next = state.queuedTurns.shift();
  if (next) {
    state.sequence += 1;
    next.status = "working";
    state.requirements = [next];
    state.active = true;
    state.turnId = "";
  } else {
    state.active = false;
  }
}

function steerPromptText(text, number) {
  return [
    `【追加要求 #${number - 1}｜不替换前面的要求】`,
    text,
    "请把它加入当前任务；原始请求和此前追加仍需一起完成。最终答复前逐项核对。",
  ].join("\n\n");
}

function queuePromptText(text) {
  return ["【下一轮任务｜当前任务完成后再做】", text].join("\n\n");
}

function lateFollowupPromptText(text) {
  return [
    "【追加要求到达时上一轮刚刚结束｜作为下一轮继续】",
    text,
    "请结合上一轮的原始请求和所有追加要求，只补做尚未覆盖的内容。",
  ].join("\n\n");
}

function turnRequirement(state, text, kind, status) {
  state.requirementSequence += 1;
  return {
    id: `requirement-${state.requirementSequence}`,
    text: String(text).slice(0, 4_000),
    kind,
    status,
  };
}

function trimTrackedRequirements(state) {
  if (state.requirements.length > MAX_TURN_REQUIREMENTS) {
    state.requirements.splice(1, state.requirements.length - MAX_TURN_REQUIREMENTS);
  }
  if (state.queuedTurns.length > MAX_TURN_REQUIREMENTS) {
    state.queuedTurns.splice(0, state.queuedTurns.length - MAX_TURN_REQUIREMENTS);
  }
}

function restoreTurnState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    active: Boolean(input.active),
    stopping: false,
    interrupted: Boolean(input.interrupted),
    interruptedAt: cleanClientLogValue(input.interruptedAt, 100),
    turnId: cleanClientLogValue(input.turnId, 100),
    lastCompletedTurnId: cleanClientLogValue(input.lastCompletedTurnId, 100),
    lastStoppedTurnId: cleanClientLogValue(input.lastStoppedTurnId, 100),
    sequence: clampInteger(input.sequence, 0, 1_000_000, 0),
    requirementSequence: clampInteger(input.requirementSequence, 0, 1_000_000, 0),
    requirements: restoreRequirements(input.requirements),
    queuedTurns: restoreRequirements(input.queuedTurns),
  };
}

function restoreRequirements(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-MAX_TURN_REQUIREMENTS).map((item, index) => ({
    id: cleanClientLogValue(item?.id, 100) || `restored-requirement-${index + 1}`,
    text: String(item?.text || "").slice(0, 4_000),
    kind: ["original", "followup", "queued"].includes(item?.kind) ? item.kind : "followup",
    status: ["working", "queued", "completed", "failed", "interrupted", "cancelled"].includes(item?.status)
      ? item.status
      : "working",
  }));
}

function interruptedTurnStateAfterProcessLoss(value, fallbackTime = "") {
  const state = restoreTurnState(value);
  const hasUnfinishedRequirement = state.requirements.some((item) =>
    ["working", "queued", "interrupted"].includes(item.status),
  );
  const incompleteTurn =
    state.active ||
    state.interrupted ||
    Boolean(state.turnId && state.turnId !== state.lastCompletedTurnId && hasUnfinishedRequirement);
  state.active = false;
  if (!incompleteTurn) return state;

  state.interrupted = true;
  state.interruptedAt = state.interruptedAt || cleanClientLogValue(fallbackTime, 100) || new Date().toISOString();
  for (const requirement of state.requirements) {
    if (requirement.status === "working") requirement.status = "interrupted";
  }
  return state;
}

function interruptedContinuationPrompt(state) {
  const requirements = (state.requirements || [])
    .filter((item) => item.status === "interrupted")
    .map((item) => `- ${item.text}`)
    .join("\n");
  return [
    "刚才这一轮因 Agent Web 服务或 App Server 进程重启而中断，没有生成最终回复。",
    requirements ? `原任务要求：\n${requirements}` : "请根据当前 Session 的最后一轮对话继续。",
    "请先核对当前工作区、Git 提交和服务状态，避免重复已经完成的操作；完成剩余验证后给出最终总结。",
    "不要停止或重启 agent-terminal-web.service。如确实需要部署，只说明需要外部重启并等待用户处理。",
  ].join("\n\n");
}

function publicTurnState(state) {
  return {
    active: Boolean(state?.active),
    stopping: Boolean(state?.stopping),
    interrupted: Boolean(state?.interrupted),
    interruptedAt: state?.interruptedAt || "",
    turnId: state?.turnId || "",
    lastCompletedTurnId: state?.lastCompletedTurnId || "",
    lastStoppedTurnId: state?.lastStoppedTurnId || "",
    requirements: state?.requirements || [],
    queuedTurns: state?.queuedTurns || [],
  };
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
    if (!recentChunks.length && chunk.bytes > MAX_FULL_REPLAY_BYTES) {
      recentChunks.push(Buffer.from(chunk.raw, "utf8").subarray(-MAX_FULL_REPLAY_BYTES).toString("utf8"));
      bytes = MAX_FULL_REPLAY_BYTES;
      break;
    }
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
  const resultState = agentSessionResultState(
    session.sessionId,
    session.turnState?.lastCompletedTurnId,
    null,
    session.hostId,
  );
  return {
    id: session.id,
    hostId: session.hostId || PERSONAL_AGENT_HOST.id,
    hostLabel: session.hostLabel || PERSONAL_AGENT_HOST.label,
    cwd: session.cwd,
    project: session.project,
    title: session.title || "New Codex session",
    pid: session.pid,
    command: session.command,
    args: session.args,
    transport: session.transport || "terminal",
    access: normalizeAccessMode(session.access),
    runtimeKernel: session.runtimeKernel === "platform" ? "platform" : "legacy",
    purpose: normalizeSessionPurpose(session.purpose),
    ready: session.ready !== false,
    suspended: Boolean(session.suspended),
    mode: session.mode,
    sessionId: session.sessionId,
    forkedFromId: session.forkedFromId || "",
    forkedFromTitle: session.forkedFromTitle || "",
    parentThreadId: session.parentThreadId || "",
    parentThreadTitle: session.parentThreadTitle || "",
    memoryProjectMode: session.memoryProjectMode === "manual" ? "manual" : "auto",
    memoryProjects: normalizeMemoryProjectNames(session.memoryProjects),
    memoryProjectSource: normalizeMemoryProjectSource(session.memoryProjectSource),
    orchestrationMode: normalizeOrchestrationMode(session.orchestrationMode),
    model: String(session.appModel || ""),
    reasoningEffort: String(session.appReasoningEffort || ""),
    tokenUsage:
      session.transport === APP_SERVER_TRANSPORT
        ? publicAppTokenUsage(session.appTokenUsage)
        : null,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    cols: session.cols,
    rows: session.rows,
    connectedClients: session.clients.size,
    detachedExpiresAt:
      session.clients.size === 0
        ? detachedExpiresAt({ ...session, detachedAt: session.detachedAt || new Date().toISOString() })
        : null,
    released: Boolean(session.released),
    releaseReason: String(session.releaseReason || ""),
    runtimeExpiresAt:
      session.transport === APP_SERVER_TRANSPORT && !session.released && !session.exited
        ? new Date(
            Date.parse(validSessionTimestamp(session.lastMeaningfulActivityAt) || new Date().toISOString()) +
              SESSION_TTL_MS,
          ).toISOString()
        : null,
    exited: session.exited,
    exitCode: session.exitCode,
    signal: session.signal,
    outputRevision: session.outputRevision,
    pendingServerRequestCount: session.pendingServerRequests?.size || 0,
    capabilities: {
      startupQueue: session.transport === APP_SERVER_TRANSPORT,
      interruptTurn: session.transport === APP_SERVER_TRANSPORT,
      appCommands: session.transport === APP_SERVER_TRANSPORT,
      skills: session.transport === APP_SERVER_TRANSPORT,
      threadSearch: session.transport === APP_SERVER_TRANSPORT,
      threadFork: session.transport === APP_SERVER_TRANSPORT,
      subagents: session.transport === APP_SERVER_TRANSPORT,
      audioInput: session.transport === APP_SERVER_TRANSPORT,
      threadTree: session.transport === APP_SERVER_TRANSPORT,
      sideChat: session.transport === APP_SERVER_TRANSPORT,
      realtimeV3: session.transport === APP_SERVER_TRANSPORT,
    },
    turnState: publicTurnState(session.turnState),
    ...resultState,
  };
}

function persistCompletedSessionPreview(session, result) {
  if (session.hostId !== PERSONAL_AGENT_HOST.id) return null;
  if (!session.sessionId || !String(result || "").trim()) return null;
  const prompt = (session.turnState?.requirements || [])
    .map((requirement) => String(requirement?.text || "").trim())
    .filter(Boolean)
    .join("\n\n");
  try {
    return saveSessionPreview(CODEX_SESSION_PREVIEWS_FILE, {
      sessionId: session.sessionId,
      prompt,
      result,
      completedAt: new Date().toISOString(),
      updatedAt: session.lastActivityAt,
    });
  } catch (error) {
    console.error(`Failed to save session preview ${session.sessionId}: ${error.message}`);
    return null;
  }
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
  if (session.transport === APP_SERVER_TRANSPORT) {
    if (session.runtimeLeaseTimer) {
      clearTimeout(session.runtimeLeaseTimer);
      session.runtimeLeaseTimer = null;
    }
    removePersistedWebSession(session.id);
    closeSideChat(session);
    session.realtime = restoreRealtimeState();
    session.turnState = interruptedTurnStateAfterProcessLoss(session.turnState);
    session.ready = false;
    session.exited = true;
    session.exitCode = 0;
    releaseAgentAppServerClient(session.appServer, { interrupt: true });
    broadcast(session, "status", publicSession(session));
    for (const client of session.clients) client.close();
    scheduleCleanup(session);
    return;
  }
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

function releaseAppServerSessionRuntime(
  session,
  { reason = APP_SERVER_RELEASE_REASON_DETACHED_TTL } = {},
) {
  if (session.runtimeLeaseTimer) {
    clearTimeout(session.runtimeLeaseTimer);
    session.runtimeLeaseTimer = null;
  }
  closeSideChat(session);
  session.realtime = restoreRealtimeState();
  session.ready = false;
  session.released = true;
  session.releaseReason = reason;
  session.exited = true;
  session.exitCode = 0;
  session.signal = null;
  persistWebSession(session);
  releaseAgentAppServerClient(session.appServer);
  broadcast(session, "status", publicSession(session));
  emitCatalogControlEvent(agentHostForSession(session));
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
  if (session.transport === APP_SERVER_TRANSPORT) {
    const hasTurn =
      session.turnState?.sequence > 0 ||
      session.turnState?.requirements?.length > 0 ||
      session.turnState?.queuedTurns?.length > 0;
    if (session.sessionId && hasTurn) persistWebSession(session);
    return;
  }
  if (USE_TMUX_SESSIONS || session.sessionId) persistWebSession(session);
}

function persistWebSession(session) {
  const records = readPersistedWebSessions();
  records[session.id] = {
    id: session.id,
    hostId: session.hostId || PERSONAL_AGENT_HOST.id,
    cwd: session.cwd,
    command: session.command,
    args: session.args,
    transport: session.transport || "terminal",
    access: normalizeAccessMode(session.access),
    runtimeKernel: session.runtimeKernel === "platform" ? "platform" : "legacy",
    purpose: normalizeSessionPurpose(session.purpose),
    thinkSkillActivated: Boolean(session.thinkSkillActivated),
    appModel: String(session.appModel || ""),
    appReasoningEffort: String(session.appReasoningEffort || ""),
    appServiceTier: ["priority", "default"].includes(session.appServiceTier) ? session.appServiceTier : null,
    orchestrationMode: normalizeOrchestrationMode(session.orchestrationMode),
    memoryProjectMode: session.memoryProjectMode === "manual" ? "manual" : "auto",
    memoryProjects: normalizeMemoryProjectNames(session.memoryProjects),
    memoryProjectSource: normalizeMemoryProjectSource(session.memoryProjectSource),
    mode: session.mode,
    sessionId: session.sessionId,
    forkedFromId: String(session.forkedFromId || ""),
    forkedFromTitle: String(session.forkedFromTitle || ""),
    parentThreadId: String(session.parentThreadId || ""),
    parentThreadTitle: String(session.parentThreadTitle || ""),
    title: session.title,
    notificationApp: session.notificationApp,
    notificationDeviceId: session.notificationDeviceId,
    tmuxName: session.tmuxName,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    detachedAt: validSessionTimestamp(session.detachedAt),
    released: Boolean(session.released),
    releaseReason:
      session.released &&
      [APP_SERVER_RELEASE_REASON_DETACHED_TTL, APP_SERVER_RELEASE_REASON_IDLE_TTL].includes(session.releaseReason)
        ? session.releaseReason
        : "",
    turnState: publicTurnState(session.turnState),
  };
  writePersistedWebSessions(records);
}

function removePersistedWebSession(id) {
  const records = readPersistedWebSessions();
  if (!records[id]) return;
  delete records[id];
  writePersistedWebSessions(records);
}

function removePersistedWebSessionsForCodexSession(sessionId, hostId = PERSONAL_AGENT_HOST.id) {
  const records = readPersistedWebSessions();
  let changed = false;
  for (const [id, record] of Object.entries(records)) {
    if (
      String(record?.sessionId || "") !== String(sessionId || "") ||
      String(record?.hostId || PERSONAL_AGENT_HOST.id) !== String(hostId || PERSONAL_AGENT_HOST.id)
    ) {
      continue;
    }
    delete records[id];
    changed = true;
  }
  if (changed) writePersistedWebSessions(records);
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

function readAgentSessionSettings() {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(AGENT_SESSION_SETTINGS_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

function agentSessionSettingsKey(sessionId, hostId = PERSONAL_AGENT_HOST.id) {
  const id = String(sessionId || "");
  if (!isValidSessionId(id)) return "";
  const normalizedHostId = String(hostId || PERSONAL_AGENT_HOST.id);
  if (normalizedHostId === PERSONAL_AGENT_HOST.id) return id;
  return /^[a-z][a-z0-9-]{0,31}$/.test(normalizedHostId)
    ? `${normalizedHostId}:${id}`
    : "";
}

function isValidAgentSessionSettingsKey(value) {
  const key = String(value || "");
  if (isValidSessionId(key)) return true;
  const separator = key.indexOf(":");
  if (separator <= 0) return false;
  return Boolean(agentSessionSettingsKey(key.slice(separator + 1), key.slice(0, separator)));
}

function agentSessionSetting(settings, sessionId, hostId = PERSONAL_AGENT_HOST.id) {
  const key = agentSessionSettingsKey(sessionId, hostId);
  const setting = key ? settings?.[key] : null;
  return setting && typeof setting === "object" ? setting : {};
}

function cleanTurnId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "")
    .slice(0, 160);
}

function validIsoTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : "";
}

function agentSessionResultState(
  sessionId,
  currentCompletedTurnId = "",
  savedSetting = null,
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const saved =
    savedSetting && typeof savedSetting === "object"
      ? savedSetting
      : isValidSessionId(sessionId)
        ? agentSessionSetting(readAgentSessionSettings(), sessionId, hostId)
        : {};
  const trackedCompletedTurnId = cleanTurnId(saved.lastCompletedTurnId);
  const lastCompletedTurnId = trackedCompletedTurnId || cleanTurnId(currentCompletedTurnId);
  const lastViewedTurnId = cleanTurnId(saved.lastViewedTurnId);
  return {
    lastCompletedTurnId,
    lastCompletedAt: validIsoTimestamp(saved.lastCompletedAt),
    lastViewedTurnId,
    lastViewedAt: validIsoTimestamp(saved.lastViewedAt),
    hasUnreadResult: Boolean(trackedCompletedTurnId && trackedCompletedTurnId !== lastViewedTurnId),
  };
}

function rememberAgentSessionCompletion(
  sessionId,
  turnId,
  completedAt = new Date().toISOString(),
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const cleanedTurnId = cleanTurnId(turnId);
  const settingsKey = agentSessionSettingsKey(sessionId, hostId);
  if (!settingsKey || !cleanedTurnId) return agentSessionResultState(sessionId, "", null, hostId);
  const settings = readAgentSessionSettings();
  const existing = settings[settingsKey] || {};
  const recentCompletedTurnIds = normalizeRecentCompletedTurnIds([
    ...(Array.isArray(existing.recentCompletedTurnIds) ? existing.recentCompletedTurnIds : []),
    cleanedTurnId,
  ]);
  const existingCompletedAt = validIsoTimestamp(existing.lastCompletedAt);
  const nextCompletedAt = validIsoTimestamp(completedAt) || new Date().toISOString();
  const keepExistingLatest =
    existingCompletedAt &&
    new Date(existingCompletedAt).getTime() > new Date(nextCompletedAt).getTime();
  settings[settingsKey] = {
    ...existing,
    access: normalizeAccessMode(existing.access),
    lastCompletedTurnId: keepExistingLatest
      ? cleanTurnId(existing.lastCompletedTurnId)
      : cleanedTurnId,
    lastCompletedAt: keepExistingLatest ? existingCompletedAt : nextCompletedAt,
    recentCompletedTurnIds,
    updatedAt: new Date().toISOString(),
  };
  writeAgentSessionSettings(settings);
  return agentSessionResultState(sessionId, cleanedTurnId, null, hostId);
}

function hasRememberedAgentSessionCompletion(
  sessionId,
  turnId,
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const cleanedTurnId = cleanTurnId(turnId);
  if (!cleanedTurnId) return false;
  const saved = agentSessionSetting(readAgentSessionSettings(), sessionId, hostId);
  return (
    cleanTurnId(saved.lastCompletedTurnId) === cleanedTurnId ||
    normalizeRecentCompletedTurnIds(saved.recentCompletedTurnIds).includes(cleanedTurnId)
  );
}

function normalizeRecentCompletedTurnIds(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((turnId) => cleanTurnId(turnId))
        .filter(Boolean),
    ),
  ].slice(-100);
}

function rememberAgentSessionViewed(
  sessionId,
  turnId,
  viewedAt = new Date().toISOString(),
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const cleanedTurnId = cleanTurnId(turnId);
  const settingsKey = agentSessionSettingsKey(sessionId, hostId);
  if (!settingsKey || !cleanedTurnId) return agentSessionResultState(sessionId, "", null, hostId);
  const settings = readAgentSessionSettings();
  const existing = settings[settingsKey] || {};
  const lastCompletedTurnId = cleanTurnId(existing.lastCompletedTurnId);
  if (lastCompletedTurnId && lastCompletedTurnId !== cleanedTurnId) {
    return agentSessionResultState(sessionId, "", null, hostId);
  }
  settings[settingsKey] = {
    ...existing,
    access: normalizeAccessMode(existing.access),
    lastViewedTurnId: cleanedTurnId,
    lastViewedAt: validIsoTimestamp(viewedAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeAgentSessionSettings(settings);
  return agentSessionResultState(sessionId, cleanedTurnId, null, hostId);
}

function rememberAgentSessionAccess(
  sessionId,
  access,
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const settingsKey = agentSessionSettingsKey(sessionId, hostId);
  if (!settingsKey) return;
  const settings = readAgentSessionSettings();
  settings[settingsKey] = {
    ...(settings[settingsKey] || {}),
    access: normalizeAccessMode(access),
    updatedAt: new Date().toISOString(),
  };

  writeAgentSessionSettings(settings);
}

function rememberAgentSessionRelation(
  sessionId,
  relation = {},
  hostId = PERSONAL_AGENT_HOST.id,
) {
  const settingsKey = agentSessionSettingsKey(sessionId, hostId);
  if (!settingsKey) return;
  const settings = readAgentSessionSettings();
  const existing = settings[settingsKey] || {};
  settings[settingsKey] = {
    ...existing,
    forkedFromId: isValidSessionId(relation.forkedFromId) ? String(relation.forkedFromId) : "",
    forkedFromTitle: cleanCustomTitle(relation.forkedFromTitle),
    parentThreadId: isValidSessionId(relation.parentThreadId) ? String(relation.parentThreadId) : "",
    parentThreadTitle: cleanCustomTitle(relation.parentThreadTitle),
    updatedAt: new Date().toISOString(),
  };
  writeAgentSessionSettings(settings);
}

function rememberAgentSessionMemoryRouting(session) {
  if (session?.hostId !== PERSONAL_AGENT_HOST.id) return;
  if (!isValidSessionId(session?.sessionId)) return;
  const settings = readAgentSessionSettings();
  settings[session.sessionId] = {
    ...(settings[session.sessionId] || {}),
    access: normalizeAccessMode(session.access),
    memoryProjectMode: session.memoryProjectMode === "manual" ? "manual" : "auto",
    memoryProjects: normalizeMemoryProjectNames(session.memoryProjects),
    memoryProjectSource: normalizeMemoryProjectSource(session.memoryProjectSource),
    updatedAt: new Date().toISOString(),
  };
  writeAgentSessionSettings(settings);
}

function writeAgentSessionSettings(settings) {
  try {
    fsSync.mkdirSync(path.dirname(AGENT_SESSION_SETTINGS_FILE), { recursive: true });
    const cleaned = Object.fromEntries(
      Object.entries(settings)
        .filter(([id, setting]) => isValidAgentSessionSettingsKey(id) && ["safe", "full"].includes(setting?.access))
        .map(([id, setting]) => [
          id,
          {
            ...setting,
            access: normalizeAccessMode(setting.access),
            memoryProjectMode: setting.memoryProjectMode === "manual" ? "manual" : "auto",
            memoryProjects: normalizeMemoryProjectNames(setting.memoryProjects),
            memoryProjectSource: normalizeMemoryProjectSource(setting.memoryProjectSource),
            forkedFromId: isValidSessionId(setting.forkedFromId) ? String(setting.forkedFromId) : "",
            forkedFromTitle: cleanCustomTitle(setting.forkedFromTitle),
            parentThreadId: isValidSessionId(setting.parentThreadId) ? String(setting.parentThreadId) : "",
            parentThreadTitle: cleanCustomTitle(setting.parentThreadTitle),
            lastCompletedTurnId: cleanTurnId(setting.lastCompletedTurnId),
            lastCompletedAt: validIsoTimestamp(setting.lastCompletedAt),
            recentCompletedTurnIds: normalizeRecentCompletedTurnIds(
              setting.recentCompletedTurnIds,
            ),
            lastViewedTurnId: cleanTurnId(setting.lastViewedTurnId),
            lastViewedAt: validIsoTimestamp(setting.lastViewedAt),
          },
        ])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    const tempFile = `${AGENT_SESSION_SETTINGS_FILE}.${process.pid}.tmp`;
    fsSync.writeFileSync(tempFile, `${JSON.stringify(cleaned, null, 2)}\n`, { mode: 0o600 });
    fsSync.renameSync(tempFile, AGENT_SESSION_SETTINGS_FILE);
  } catch (error) {
    console.error(`Failed to write agent session settings: ${error.message}`);
  }
}

function initialSessionMemoryRouting(sessionId, restored = {}) {
  const saved = isValidSessionId(sessionId)
    ? agentSessionSetting(readAgentSessionSettings(), sessionId, PERSONAL_AGENT_HOST.id)
    : {};
  const modeValue = restored.memoryProjectMode !== undefined ? restored.memoryProjectMode : saved.memoryProjectMode;
  const projectValue = restored.memoryProjects !== undefined ? restored.memoryProjects : saved.memoryProjects;
  const sourceValue = restored.memoryProjectSource !== undefined ? restored.memoryProjectSource : saved.memoryProjectSource;
  return {
    mode: modeValue === "manual" ? "manual" : "auto",
    projects: normalizeMemoryProjectNames(projectValue),
    source: normalizeMemoryProjectSource(sourceValue),
  };
}

function normalizeMemoryProjectNames(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item || "").trim().slice(0, 300)).filter((item) => item && item !== "."))].slice(0, 20);
}

function normalizeMemoryProjectSource(value) {
  return ["manual", "prompt", "retained", "cwd", "title", "global"].includes(value) ? value : "global";
}

function knowledgeChangeView(changes, view) {
  const all = Array.isArray(changes) ? changes : [];
  const counts = all.reduce(
    (result, change) => {
      result.total += 1;
      result[change.status] = (result[change.status] || 0) + 1;
      result[change.targetType] = (result[change.targetType] || 0) + 1;
      return result;
    },
    { total: 0, pending: 0, auto_applied: 0, approved: 0, rejected: 0, reverted: 0, conflict: 0, superseded: 0, personal_memory: 0, project_rule: 0, skill: 0, native_review: 0 },
  );
  const selected = view === "pending"
    ? all.filter((change) => change.status === "pending")
    : view === "changes"
      ? orderKnowledgeChanges(all)
      : [];
  return { counts, changes: selected.slice(0, 250) };
}

function workspaceMemoryProjectNames() {
  try {
    return fsSync
      .readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "uploads")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function mergeMemoryProjectCatalog(catalog, knownProjects) {
  const projects = new Map();
  for (const item of Array.isArray(catalog) ? catalog : []) {
    const project = String(item?.project || "").trim();
    if (!project || project.toLowerCase() === "workspace") continue;
    projects.set(project.toLowerCase(), { project, count: Math.max(0, Number(item.count) || 0) });
  }
  for (const raw of Array.isArray(knownProjects) ? knownProjects : []) {
    const project = String(raw || "").trim();
    if (!project || project.toLowerCase() === "workspace" || projects.has(project.toLowerCase())) continue;
    projects.set(project.toLowerCase(), { project, count: 0 });
  }
  return [...projects.values()].sort((a, b) => a.project.localeCompare(b.project));
}

function savedAgentSessionAccess(
  sessionId,
  agentHost = PERSONAL_AGENT_HOST,
  persistedRecords = readPersistedWebSessions(),
) {
  const setting = agentSessionSetting(readAgentSessionSettings(), sessionId, agentHost.id);
  const scopedRecords = Object.fromEntries(
    Object.entries(persistedRecords).filter(
      ([, record]) => (record.hostId || PERSONAL_AGENT_HOST.id) === agentHost.id,
    ),
  );
  return preferredAccessForCodexSession(
    { [sessionId]: setting },
    scopedRecords,
    sessionId,
  );
}

function isValidWebSessionId(value) {
  return /^[a-z0-9-]{8,80}$/i.test(String(value || ""));
}

function isCodexTurnId(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ""));
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

function requestAgentHost(req, res) {
  const agentHost = resolveAgentHost(AGENT_HOSTS, req.query.host);
  if (agentHost) return agentHost;
  res.status(404).json({ error: "Unknown Agent host." });
  return null;
}

function agentHostForSession(session) {
  return resolveAgentHost(AGENT_HOSTS, session?.hostId) || PERSONAL_AGENT_HOST;
}

function agentSessionFavoritesFile(agentHost = PERSONAL_AGENT_HOST) {
  if (agentHost.id === PERSONAL_AGENT_HOST.id) return AGENT_SESSION_FAVORITES_FILE;
  return path.join(AGENT_HOST_STATE_DIR, `${agentHost.id}-favorites.json`);
}

function favoriteSessionIdsForHost(agentHost = PERSONAL_AGENT_HOST) {
  return new Set(readAgentSessionFavorites(agentSessionFavoritesFile(agentHost)));
}

function normalizeSessionPurpose(value) {
  return value === THINK_SESSION_PURPOSE ? THINK_SESSION_PURPOSE : "";
}

function terminalLaunchArgs(access, tail = []) {
  const args = ["--no-alt-screen"];
  if (normalizeAccessMode(access) === FULL_ACCESS_MODE) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  return [...args, ...tail];
}

async function getLaunchConfig(searchParams, agentHost = PERSONAL_AGENT_HOST) {
  const transport = searchParams.get("transport") === "terminal" ? "terminal" : APP_SERVER_TRANSPORT;
  const purpose = normalizeSessionPurpose(searchParams.get("purpose"));
  const sessionId = String(searchParams.get("sessionId") || "").trim();
  if (sessionId && !/^[a-zA-Z0-9._:-]+$/.test(sessionId)) return null;
  const access = searchParams.has("access")
    ? normalizeAccessMode(searchParams.get("access"))
    : savedAgentSessionAccess(sessionId, agentHost) || FULL_ACCESS_MODE;

  if (sessionId) {
    return {
      mode: "resume-id",
      transport,
      access,
      purpose,
      sessionId,
      args: transport === APP_SERVER_TRANSPORT ? ["app-server"] : terminalLaunchArgs(access, ["resume", sessionId]),
    };
  }

  const mode = String(searchParams.get("mode") || "new");
  if (mode === "new") {
    return {
      mode,
      transport,
      access,
      purpose,
      sessionId: "",
      args: transport === APP_SERVER_TRANSPORT ? ["app-server"] : terminalLaunchArgs(access),
    };
  }
  if (mode === "resume-picker") {
    if (transport === APP_SERVER_TRANSPORT) return null;
    return { mode, transport, access, purpose, sessionId: "", args: terminalLaunchArgs(access, ["resume"]) };
  }
  if (mode === "resume-last") {
    if (transport === APP_SERVER_TRANSPORT) {
      const [latest] = await listCodexSessions({ archived: false, agentHost });
      if (!latest?.id) return null;
      return { mode, transport, access, purpose, sessionId: latest.id, args: ["app-server"] };
    }
    return { mode, transport, access, purpose, sessionId: "", args: terminalLaunchArgs(access, ["resume", "--last"]) };
  }
  return null;
}

async function titleForLaunch(launch) {
  const agentHost = launch.agentHost || PERSONAL_AGENT_HOST;
  if (launch.sessionId) {
    if (agentHost.type === "ssh") {
      const thread = await withStandaloneAppServer(agentHost, (client) =>
        client.readThread({ threadId: launch.sessionId, includeTurns: false }),
      ).catch(() => null);
      return cleanCustomTitle(thread?.name) || cleanTitle(thread?.preview) || "";
    }
    const meta = await readCodexSessionById(launch.sessionId);
    return meta?.title || "";
  }

  if (launch.mode === "resume-last") {
    const [latest] = await listCodexSessions({ archived: false, agentHost });
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

async function findCodexSessionFile(id) {
  const cached = codexSessionFileCache.get(id);
  if (cached) {
    try {
      await fs.access(cached);
      return cached;
    } catch {
      codexSessionFileCache.delete(id);
    }
  }
  const roots = [CODEX_SESSIONS_ROOT, CODEX_ARCHIVED_SESSIONS_ROOT];
  for (const root of roots) {
    const files = await walkFiles(root);
    const match = files.find((file) => file.endsWith(".jsonl") && sessionIdFromFilename(file) === id);
    if (match) {
      codexSessionFileCache.set(id, match);
      return match;
    }
  }
  return "";
}

async function loadHistoricalSessionProcess(session, turnId) {
  const file = await findCodexSessionFile(session.sessionId);
  if (!file) return [];
  return extractSessionProcessFromJsonl(file, turnId, {
    indexFile: sessionProcessIndexFile(session.sessionId),
  });
}

function sessionProcessIndexFile(sessionId) {
  return path.join(CODEX_SESSION_PROCESS_INDEX_ROOT, `${String(sessionId)}.json`);
}

function scheduleSessionProcessIndexWarm(session) {
  if (
    session?.hostId !== PERSONAL_AGENT_HOST.id ||
    !isValidSessionId(session.sessionId)
  ) {
    return;
  }
  sessionProcessIndexWarmQueue.set(session.sessionId, {
    sessionId: session.sessionId,
    webSessionId: session.id,
  });
  if (sessionProcessIndexWarmRunning || sessionProcessIndexWarmTimer) return;
  sessionProcessIndexWarmTimer = setTimeout(drainSessionProcessIndexWarmQueue, 5_000);
  sessionProcessIndexWarmTimer.unref?.();
}

async function drainSessionProcessIndexWarmQueue() {
  sessionProcessIndexWarmTimer = null;
  if (sessionProcessIndexWarmRunning) return;
  const next = sessionProcessIndexWarmQueue.entries().next().value;
  if (!next) return;
  const [sessionId, task] = next;
  sessionProcessIndexWarmRunning = true;
  const startedAt = Date.now();
  try {
    const file = await findCodexSessionFile(sessionId);
    if (file) {
      await warmSessionProcessIndex(file, sessionProcessIndexFile(sessionId));
      logAgentEvent("session-process-index-warm", {
        webSessionId: task.webSessionId,
        codexSessionId: sessionId,
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    logAgentEvent("session-process-index-warm-failed", {
      webSessionId: task.webSessionId,
      codexSessionId: sessionId,
      durationMs: Date.now() - startedAt,
      message: cleanClientLogValue(error.message, 300),
    });
  } finally {
    sessionProcessIndexWarmQueue.delete(sessionId);
    sessionProcessIndexWarmRunning = false;
    if (sessionProcessIndexWarmQueue.size > 0) {
      sessionProcessIndexWarmTimer = setTimeout(drainSessionProcessIndexWarmQueue, 50);
      sessionProcessIndexWarmTimer.unref?.();
    }
  }
}

async function listCodexSessions({ archived, agentHost = PERSONAL_AGENT_HOST }) {
  if (nativeThreadCatalogEnabled(agentHost)) {
    try {
      return await listCodexSessionsFromAppServer({ archived, agentHost });
    } catch (error) {
      logAgentEvent("native-thread-list-fallback", {
        archived,
        hostId: agentHost.id,
        message: cleanClientLogValue(error.message, 300),
      });
      if (agentHost.type === "ssh") {
        throw new Error(`Remote Agent host ${agentHost.label} is unavailable: ${error.message}`);
      }
    }
  }
  return listCodexSessionsFromFiles({ archived });
}

async function listCodexSessionsFromAppServer({ archived, agentHost = PERSONAL_AGENT_HOST }) {
  const [page, customTitles, persistedRecords] = await Promise.all([
    cachedThreadCatalogPage({ archived, agentHost }),
    agentHost.type === "local" ? readSessionTitles() : Promise.resolve({}),
    Promise.resolve(
      Object.fromEntries(
        Object.entries(readPersistedWebSessions()).filter(
          ([, record]) => (record.hostId || PERSONAL_AGENT_HOST.id) === agentHost.id,
        ),
      ),
    ),
  ]);
  const persistedByCodexId = latestPersistedSessionsByCodexId(persistedRecords);
  const sessionSettings = readAgentSessionSettings();
  return (Array.isArray(page?.data) ? page.data : [])
    .map((thread) => nativeThreadSessionMeta(thread, {
      archived: Boolean(archived),
      customTitles,
      persistedByCodexId,
      sessionSettings,
      agentHost,
    }))
    .filter(Boolean);
}

async function cachedThreadCatalogPage({ archived, agentHost = PERSONAL_AGENT_HOST }) {
  const key = `${agentHost.id}:${Boolean(archived) ? "archived" : "active"}`;
  const cached = threadCatalogPageCache.get(key);
  if (cached?.page && Date.now() - cached.updatedAt < THREAD_CATALOG_CACHE_MS) {
    return cached.page;
  }
  if (cached?.promise) return cached.promise;

  const promise = withStandaloneAppServer(agentHost, (client) =>
    client.listThreads({
      archived: Boolean(archived),
      limit: 40,
      sortKey: "updated_at",
      sortDirection: "desc",
    }),
  );
  threadCatalogPageCache.set(key, {
    page: cached?.page || null,
    updatedAt: cached?.updatedAt || 0,
    promise,
  });
  try {
    const page = await promise;
    if (threadCatalogPageCache.get(key)?.promise === promise) {
      threadCatalogPageCache.set(key, { page, updatedAt: Date.now(), promise: null });
    }
    return page;
  } catch (error) {
    if (cached?.page && threadCatalogPageCache.get(key)?.promise === promise) {
      threadCatalogPageCache.set(key, {
        page: cached.page,
        updatedAt: cached.updatedAt,
        promise: null,
      });
    }
    if (cached?.page) {
      logAgentEvent("thread-catalog-stale-fallback", {
        hostId: agentHost.id,
        archived: Boolean(archived),
        message: cleanClientLogValue(error?.message, 300),
      });
      return cached.page;
    }
    if (threadCatalogPageCache.get(key)?.promise === promise) threadCatalogPageCache.delete(key);
    throw error;
  }
}

function invalidateThreadCatalog(agentHost = PERSONAL_AGENT_HOST) {
  const prefix = `${agentHost.id}:`;
  for (const key of threadCatalogPageCache.keys()) {
    if (key.startsWith(prefix)) threadCatalogPageCache.delete(key);
  }
  emitCatalogControlEvent(agentHost);
}

async function listCodexSessionsFromFiles({ archived }) {
  const activeFiles = (await walkFiles(CODEX_SESSIONS_ROOT)).map((file) => ({ file, fileArchived: false }));
  const archivedFiles = (await walkFiles(CODEX_ARCHIVED_SESSIONS_ROOT)).map((file) => ({
    file,
    fileArchived: true,
  }));
  const files = [...activeFiles, ...archivedFiles];
  const customTitles = await readSessionTitles();
  const archivedSessions = await readSessionArchive();
  const persistedRecords = readPersistedWebSessions();
  const persistedByCodexId = latestPersistedSessionsByCodexId(persistedRecords);
  const sessionSettings = readAgentSessionSettings();
  const items = [];

  for (const { file, fileArchived } of files) {
    if (!file.endsWith(".jsonl")) continue;
    const meta = await readCodexSessionMeta(file, customTitles, archivedSessions, fileArchived);
    if (!meta) continue;
    meta.hostId = PERSONAL_AGENT_HOST.id;
    meta.hostLabel = PERSONAL_AGENT_HOST.label;
    const savedSetting = agentSessionSetting(
      sessionSettings,
      meta.id,
      PERSONAL_AGENT_HOST.id,
    );
    meta.access = normalizeAccessMode(
      savedSetting.access || persistedByCodexId.get(meta.id)?.access,
    );
    Object.assign(
      meta,
      agentSessionResultState(meta.id, "", savedSetting, PERSONAL_AGENT_HOST.id),
    );
    if (Boolean(meta.archived) === archived) items.push(meta);
  }

  return items
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 40);
}

async function searchCodexSessions(searchTerm, agentHost = PERSONAL_AGENT_HOST) {
  if (!nativeThreadCatalogEnabled(agentHost)) {
    const [active, archived] = await Promise.all([
      listCodexSessionsFromFiles({ archived: false }),
      listCodexSessionsFromFiles({ archived: true }),
    ]);
    const query = searchTerm.toLocaleLowerCase();
    return [...active, ...archived]
      .filter((session) => `${session.title}\n${session.project}`.toLocaleLowerCase().includes(query))
      .slice(0, APP_SEARCH_RESULT_LIMIT)
      .map((session) => ({ session, snippet: session.title }));
  }

  const [pages, customTitles] = await Promise.all([
    withStandaloneAppServer(agentHost, async (client) => {
      const active = await client.searchThreads(searchTerm, {
        archived: false,
        limit: APP_SEARCH_RESULT_LIMIT,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      const archived = await client.searchThreads(searchTerm, {
        archived: true,
        limit: APP_SEARCH_RESULT_LIMIT,
        sortKey: "updated_at",
        sortDirection: "desc",
      });
      return [active, archived];
    }),
    agentHost.type === "local" ? readSessionTitles() : Promise.resolve({}),
  ]);
  const persistedByCodexId = latestPersistedSessionsByCodexId(
    Object.fromEntries(
      Object.entries(readPersistedWebSessions()).filter(
        ([, record]) => (record.hostId || PERSONAL_AGENT_HOST.id) === agentHost.id,
      ),
    ),
  );
  const sessionSettings = readAgentSessionSettings();
  return pages
    .flatMap((page, pageIndex) =>
      (Array.isArray(page?.data) ? page.data : []).map((result) => ({
        session: nativeThreadSessionMeta(result.thread, {
          archived: pageIndex === 1,
          customTitles,
          persistedByCodexId,
          sessionSettings,
          agentHost,
        }),
        snippet: String(result?.snippet || ""),
      })),
    )
    .filter((result) => result.session)
    .sort((left, right) => new Date(right.session.updatedAt).getTime() - new Date(left.session.updatedAt).getTime())
    .slice(0, APP_SEARCH_RESULT_LIMIT);
}

function nativeThreadSessionMeta(
  thread,
  { archived, customTitles, persistedByCodexId, sessionSettings, agentHost = PERSONAL_AGENT_HOST },
) {
  const id = String(thread?.id || "");
  if (!isValidSessionId(id)) return null;
  const persisted = persistedByCodexId.get(id) || null;
  const savedSetting = agentSessionSetting(sessionSettings, id, agentHost.id);
  const name = cleanCustomTitle(thread?.name);
  const sidecarTitle = cleanCustomTitle(customTitles[id]);
  const generatedTitle = cleanTitle(thread?.preview) || "Untitled session";
  const updatedAt = unixSecondsToIso(thread?.updatedAt) || unixSecondsToIso(thread?.createdAt) || new Date(0).toISOString();
  const resultState = agentSessionResultState(id, "", savedSetting, agentHost.id);
  return {
    id,
    hostId: agentHost.id,
    hostLabel: agentHost.label,
    title: name || sidecarTitle || generatedTitle,
    originalTitle: generatedTitle,
    customTitle: name || sidecarTitle,
    archived,
    archivedAt: archived ? updatedAt : "",
    cwd: String(thread?.cwd || ""),
    project: agentHostProject(agentHost, String(thread?.cwd || "")),
    source: thread?.source || "",
    cliVersion: String(thread?.cliVersion || ""),
    createdAt: unixSecondsToIso(thread?.createdAt) || updatedAt,
    updatedAt,
    access: normalizeAccessMode(savedSetting.access || persisted?.access),
    forkedFromId: String(
      thread?.forkedFromId || savedSetting.forkedFromId || persisted?.forkedFromId || "",
    ),
    parentThreadId: String(
      thread?.parentThreadId || savedSetting.parentThreadId || persisted?.parentThreadId || "",
    ),
    agentNickname: String(thread?.agentNickname || ""),
    agentRole: String(thread?.agentRole || ""),
    ...resultState,
  };
}

function nativeThreadCatalogEnabled(agentHost = PERSONAL_AGENT_HOST) {
  if (agentHost.type === "ssh") return true;
  if (process.env.AGENT_NATIVE_THREAD_CATALOG === "0") return false;
  if (process.env.AGENT_NATIVE_THREAD_CATALOG === "1") return true;
  return path.resolve(CODEX_HOME) === path.resolve(path.join(process.env.HOME, ".codex"));
}

async function withStandaloneAppServer(agentHost, run) {
  if (typeof agentHost === "function") {
    run = agentHost;
    agentHost = PERSONAL_AGENT_HOST;
  }
  if (agentHost.type === "ssh") {
    const client = createAgentAppServerClient(
      agentHost.workspaceRoot,
      `catalog-${agentHost.id}-${cryptoRandomId()}`,
      undefined,
      agentHost,
    );
    try {
      await client.start();
      return await run(client);
    } finally {
      client.close();
    }
  }
  if (SHARED_APP_SERVER_ENABLED) {
    const client = await sharedCatalogAppServer();
    return run(client);
  }
  cancelCatalogAppServerIdleStop();
  catalogAppServerActiveUses += 1;
  try {
    const client = await sharedCatalogAppServer();
    return await run(client);
  } finally {
    catalogAppServerActiveUses -= 1;
    scheduleCatalogAppServerIdleStop();
  }
}

async function sharedCatalogAppServer() {
  if (catalogAppServerClient?.started && !catalogAppServerClient.closed) return catalogAppServerClient;
  if (catalogAppServerStart) return catalogAppServerStart;

  catalogAppServerStart = (async () => {
    const client = SHARED_APP_SERVER_ENABLED
      ? createAgentAppServerClient(WORKSPACE_ROOT, `catalog-${cryptoRandomId()}`)
      : new CodexAppServerClient({
          cwd: WORKSPACE_ROOT,
          command: process.env.CODEX_APP_SERVER_COMMAND || "codex",
          args: ["app-server", "-c", "mcp_servers={}"],
          env: codexEnvironmentForWeb(`catalog-${cryptoRandomId()}`),
        });
    client.on("exit", () => {
      if (catalogAppServerClient === client) catalogAppServerClient = null;
    });
    await client.start();
    catalogAppServerClient = client;
    return client;
  })();
  try {
    return await catalogAppServerStart;
  } finally {
    catalogAppServerStart = null;
  }
}

function cancelCatalogAppServerIdleStop() {
  if (!catalogAppServerIdleTimer) return;
  clearTimeout(catalogAppServerIdleTimer);
  catalogAppServerIdleTimer = null;
}

function scheduleCatalogAppServerIdleStop() {
  if (
    catalogAppServerActiveUses ||
    catalogAppServerIdleTimer ||
    !catalogAppServerClient
  ) {
    return;
  }
  catalogAppServerIdleTimer = setTimeout(() => {
    catalogAppServerIdleTimer = null;
    if (catalogAppServerActiveUses) {
      scheduleCatalogAppServerIdleStop();
      return;
    }
    const client = catalogAppServerClient;
    catalogAppServerClient = null;
    if (!client || client.closed) return;
    client.close();
    logAgentEvent("catalog-app-server-stopped", { reason: "idle" });
  }, CATALOG_APP_SERVER_IDLE_MS);
  catalogAppServerIdleTimer.unref?.();
}

async function setPersistedThreadName(threadId, title, agentHost = PERSONAL_AGENT_HOST) {
  const live = [...sessions.values()].find(
    (session) =>
      !session.exited &&
      session.ready &&
      session.transport === APP_SERVER_TRANSPORT &&
      session.hostId === agentHost.id &&
      session.sessionId === threadId,
  );
  if (live) {
    await live.appServer.setThreadName(title, threadId);
    invalidateThreadCatalog(agentHost);
    return true;
  }
  if (!nativeThreadCatalogEnabled(agentHost)) return false;
  await withStandaloneAppServer(agentHost, (client) => client.setThreadName(title, threadId));
  invalidateThreadCatalog(agentHost);
  return true;
}

function publicThreadSearchOccurrence(occurrence) {
  return {
    turnId: String(occurrence?.turnId || ""),
    itemId: String(occurrence?.itemId || ""),
    snippet: String(occurrence?.snippet || "").slice(0, 4_000),
    snippetMatchRange: {
      start: Math.max(0, Number(occurrence?.snippetMatchRange?.start) || 0),
      end: Math.max(0, Number(occurrence?.snippetMatchRange?.end) || 0),
    },
    turnCursor: String(occurrence?.turnCursor || ""),
  };
}

async function searchAppServerOccurrencesFallback(session, searchTerm) {
  const query = searchTerm.toLocaleLowerCase();
  const occurrences = [];
  let cursor = null;
  let scannedTurns = 0;

  while (scannedTurns < APP_SEARCH_HYDRATE_MAX_TURNS * 2) {
    const page = await session.appServer.listThreadTurns({
      limit: 50,
      cursor,
      sortDirection: "desc",
      itemsView: "full",
    });
    const turns = Array.isArray(page?.data) ? page.data : [];
    scannedTurns += turns.length;
    for (const turn of turns) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        let text = "";
        if (item?.type === "userMessage") text = appServerUserMessageContent(session, item.content).text;
        if (item?.type === "agentMessage" && item.phase === "final_answer") text = String(item.text || "");
        const matchIndex = text.toLocaleLowerCase().indexOf(query);
        if (matchIndex < 0) continue;
        const snippetStart = Math.max(0, matchIndex - 80);
        const snippetEnd = Math.min(text.length, matchIndex + searchTerm.length + 140);
        occurrences.push({
          turnId: String(turn?.id || ""),
          itemId: String(item?.id || ""),
          snippet: `${snippetStart ? "…" : ""}${text.slice(snippetStart, snippetEnd)}${snippetEnd < text.length ? "…" : ""}`,
          snippetMatchRange: {
            start: matchIndex - snippetStart + (snippetStart ? 1 : 0),
            end: matchIndex - snippetStart + (snippetStart ? 1 : 0) + searchTerm.length,
          },
          turnCursor: "",
          startedAt: Number(turn?.startedAt || 0),
        });
      }
    }
    cursor = page?.nextCursor || null;
    if (!cursor || !turns.length) break;
  }

  occurrences.sort((left, right) => left.startedAt - right.startedAt);
  return {
    data: occurrences.slice(0, APP_SEARCH_RESULT_LIMIT),
    nextCursor: null,
  };
}

function cleanSearchTerm(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function unixSecondsToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  return new Date(seconds * 1_000).toISOString();
}

function threadStatusLabel(status) {
  const type = String(status?.type || status || "");
  return {
    active: "运行中",
    idle: "已完成",
    notLoaded: "未载入",
    systemError: "错误",
  }[type] || type || "未知";
}

async function listRecentAgentSessions(limit = 40) {
  const savedSessions = await listCodexSessions({ archived: false });
  const previews = readSessionPreviews(CODEX_SESSION_PREVIEWS_FILE);
  const persistedByCodexId = latestPersistedSessionsByCodexId(readPersistedWebSessions());
  const liveSessions = [
    ...[...sessions.values()].filter((session) => !session.exited).map(publicSession),
    ...listDetachedSessions(),
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
      const title = cleanCustomTitle(liveSession?.title) || session.title || "Untitled session";
      const project = liveSession?.project || session.project || ".";
      const persisted = persistedByCodexId.get(session.id) || null;
      const preview = previews[session.id] || null;
      return {
        id: session.id,
        title,
        project,
        updatedAt,
        current: Boolean(liveSession),
        live: Boolean(liveSession && !liveSession.released && !liveSession.suspended),
        suspended: Boolean(liveSession?.suspended),
        released: Boolean(liveSession?.released),
        webSessionId: liveSession?.id || "",
        transport: liveSession?.transport || "terminal",
        access: normalizeAccessMode(liveSession?.access || session.access || persisted?.access),
        lastResult: preview?.result || "",
        lastCompletedAt: preview?.completedAt || "",
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
      forkedFromId: String(payload.forked_from_id || payload.forkedFromId || ""),
      parentThreadId: String(payload.parent_thread_id || payload.parentThreadId || ""),
      agentNickname: String(payload.agent_nickname || payload.agentNickname || ""),
      agentRole: String(payload.agent_role || payload.agentRole || ""),
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
    return normalizeSessionArchive(JSON.parse(raw));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.error(`Failed to read session archive: ${error.message}`);
    return {};
  }
}

function readSessionArchiveSync() {
  try {
    return normalizeSessionArchive(JSON.parse(fsSync.readFileSync(CODEX_SESSION_ARCHIVE_FILE, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.error(`Failed to read session archive: ${error.message}`);
    return {};
  }
}

function normalizeSessionArchive(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([id, record]) => {
        const archivedAt =
          record && typeof record === "object" ? String(record.archivedAt || "") : String(record || "");
        return [String(id), { archivedAt }];
      })
      .filter(([id]) => isValidSessionId(id)),
  );
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

async function setSessionArchived(id, archived, agentHost = PERSONAL_AGENT_HOST) {
  if (agentHost.type === "local") {
    const archive = await readSessionArchive();
    if (archived) {
      archive[id] = { archivedAt: new Date().toISOString() };
    } else {
      delete archive[id];
    }
    await writeSessionArchive(archive);
  }

  try {
    await withStandaloneAppServer(agentHost, (client) => client.setThreadArchived(archived, id));
  } catch (error) {
    console.warn(`Codex ${archived ? "archive" : "unarchive"} failed for ${id}: ${error.message}`);
  } finally {
    invalidateThreadCatalog(agentHost);
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
  let text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  const runtimeContextPrefixes = [
    "# AGENTS.md instructions",
    "<environment_context>",
    "<permissions instructions>",
    "<skills_instructions>",
    "<multi_agent_mode>",
    "<apps_instructions>",
    "<plugins_instructions>",
    "<recommended_plugins>",
    "<collaboration_mode>",
    "<personal-memory>",
    "<skill>",
  ];
  if (runtimeContextPrefixes.some((prefix) => text.startsWith(prefix))) return "";
  if (text.startsWith("You are Codex,")) return "";
  text = text.replace(/^\$[a-zA-Z][\w-]*(?:\s+|$)/, "").trim();
  if (!text) return "";
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
  if (type === "status") queueSessionControlEvent(session);
}

function queueSessionControlEvent(session) {
  if (!session?.id || pendingSessionControlEvents.has(session.id)) return;
  const timer = setTimeout(() => {
    pendingSessionControlEvents.delete(session.id);
    const agentHost = agentHostForSession(session);
    emitControlEvent({
      type: "session",
      session: {
        ...publicSession(session),
        favorited: session.sessionId
          ? favoriteSessionIdsForHost(agentHost).has(session.sessionId)
          : false,
      },
    });
  }, 250);
  timer.unref?.();
  pendingSessionControlEvents.set(session.id, timer);
}

function emitCatalogControlEvent(agentHost = PERSONAL_AGENT_HOST) {
  emitControlEvent({ type: "catalog", hostId: agentHost.id });
}

function emitControlEvent(payload) {
  for (const response of controlEventClients) writeControlEvent(response, payload);
}

function acceptRemoteAgentNotificationRequest() {
  const now = Date.now();
  if (now - remoteAgentNotifyRateWindow.startedAt >= REMOTE_AGENT_NOTIFY_RATE_WINDOW_MS) {
    remoteAgentNotifyRateWindow = { startedAt: now, requests: 0 };
  }
  remoteAgentNotifyRateWindow.requests += 1;
  return remoteAgentNotifyRateWindow.requests <= REMOTE_AGENT_NOTIFY_RATE_LIMIT;
}

function writeControlEvent(response, payload) {
  try {
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    controlEventClients.delete(response);
  }
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
  const parts = Object.fromEntries(
    AGENT_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatBytes(bytes) {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}
