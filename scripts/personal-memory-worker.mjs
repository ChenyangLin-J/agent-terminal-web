#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  applyPersonalMemoryProposals,
  personalMemoryFiles,
  reconcilePersonalMemoryMarkdown,
  readPersonalMemoryRuntime,
  readPersonalMemoryStore,
  writePersonalMemoryRuntime,
} from "../lib/personal-memories.js";
import {
  buildPersonalMemoryExtractionPrompt,
  conversationFromRollout,
  recordWorkerUsage,
  shouldProcessConversation,
  usageAlertNeeded,
  usageFromCodexEvents,
} from "../lib/personal-memory-worker.js";
import { recordProjectAndSkillProposals } from "../../memory-system/lib/legacy-adapter.js";
import { readKnowledgeChanges } from "../../memory-system/lib/change-ledger.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const AGENT_SESSION_SETTINGS_FILE = path.join(CODEX_HOME, "agent-session-settings.json");
const SCHEMA_FILE = path.join(REPO_ROOT, "config", "personal-memory-output.schema.json");
const HOME_PUSH_URL = process.env.HOME_PUSH_URL || "http://127.0.0.1:3050/internal/push";
const IDLE_MS = Math.max(60_000, Number(process.env.PERSONAL_MEMORY_IDLE_MS) || 10 * 60_000);
const EXTRACTION_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.PERSONAL_MEMORY_EXTRACTION_TIMEOUT_MS) || 20 * 60_000,
);
const USAGE_TOKEN_ALERT = Math.max(1, Number(process.env.PERSONAL_MEMORY_USAGE_TOKEN_ALERT) || 250_000);
const USAGE_RUN_ALERT = Math.max(1, Number(process.env.PERSONAL_MEMORY_USAGE_RUN_ALERT) || 20);
const WORKER_LOCK = path.join(personalMemoryFiles(CODEX_HOME).root, "worker.lock");
const args = new Set(process.argv.slice(2));

let lock;
try {
  lock = await acquireWorkerLock();
  if (args.has("--initialize")) await initialize();
  else if (args.has("--status")) await printStatus();
  else await run();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  await lock?.close().catch(() => {});
  if (lock) await fs.unlink(WORKER_LOCK).catch(() => {});
}

async function initialize() {
  const threads = listEligibleThreads();
  const runtime = await readPersonalMemoryRuntime(CODEX_HOME);
  for (const thread of threads) {
    const raw = await fs.readFile(thread.rolloutPath, "utf8").catch(() => "");
    const conversation = conversationFromRollout(raw);
    const stat = await fs.stat(thread.rolloutPath).catch(() => null);
    runtime.threads[thread.id] = {
      rolloutPath: thread.rolloutPath,
      offset: stat?.size || Buffer.byteLength(raw),
      lastEventAt: conversation.lastEventAt,
      updatedAtMs: thread.updatedAtMs,
      processedAt: new Date().toISOString(),
      retryCount: 0,
      nextRetryAt: null,
      lastError: "",
    };
  }
  runtime.initializedAt ||= new Date().toISOString();
  runtime.status = "idle";
  runtime.lastRunAt = new Date().toISOString();
  runtime.lastSuccessAt = runtime.lastRunAt;
  runtime.lastError = "";
  runtime.consecutiveFailures = 0;
  runtime.lastRun = { scanned: threads.length, eligible: 0, processed: 0, created: 0, confirmed: 0, pending: 0, failed: 0 };
  await writePersonalMemoryRuntime(CODEX_HOME, runtime);
  console.log(JSON.stringify({ initialized: threads.length, runtime: personalMemoryFiles(CODEX_HOME).runtime }));
}

async function printStatus() {
  console.log(JSON.stringify(await readPersonalMemoryRuntime(CODEX_HOME), null, 2));
}

async function run() {
  const startedAt = new Date();
  const runtime = await readPersonalMemoryRuntime(CODEX_HOME);
  if (!runtime.initializedAt) throw new Error("Personal memory worker is not initialized. Run with --initialize first.");
  runtime.status = "running";
  runtime.lastRunAt = startedAt.toISOString();
  await writePersonalMemoryRuntime(CODEX_HOME, runtime);
  await reconcilePersonalMemoryMarkdown(CODEX_HOME);

  const threads = listEligibleThreads();
  const reviewHistory = await readKnowledgeChanges({
    codexHome: CODEX_HOME,
    workspaceRoot: path.resolve(REPO_ROOT, ".."),
  });
  const summary = { scanned: threads.length, eligible: 0, processed: 0, created: 0, confirmed: 0, pending: 0, failed: 0 };
  let pendingCreated = 0;
  let lastError = "";

  for (const thread of threads) {
    if (Date.now() - thread.updatedAtMs < IDLE_MS) continue;
    const threadState = runtime.threads[thread.id] || null;
    if (threadState?.nextRetryAt && Date.parse(threadState.nextRetryAt) > Date.now()) continue;
    const stat = await fs.stat(thread.rolloutPath).catch(() => null);
    if (!stat) continue;
    if (threadState && threadState.offset >= stat.size && threadState.updatedAtMs >= thread.updatedAtMs) continue;
    summary.eligible += 1;

    try {
      const raw = await fs.readFile(thread.rolloutPath, "utf8");
      const conversation = conversationFromRollout(raw, threadState?.lastEventAt || "");
      const nextState = {
        rolloutPath: thread.rolloutPath,
        offset: stat.size,
        lastEventAt: conversation.lastEventAt,
        updatedAtMs: thread.updatedAtMs,
        processedAt: new Date().toISOString(),
        retryCount: 0,
        nextRetryAt: null,
        lastError: "",
      };
      if (!shouldProcessConversation(thread, conversation)) {
        runtime.threads[thread.id] = nextState;
        await writePersonalMemoryRuntime(CODEX_HOME, runtime);
        continue;
      }

      const store = await readPersonalMemoryStore(CODEX_HOME);
      const prompt = buildPersonalMemoryExtractionPrompt({
        thread,
        conversation,
        existingEntries: store.entries,
        reviewDecisions: reviewHistory.changes,
      });
      const extraction = await runExtraction(prompt);
      recordWorkerUsage(runtime, extraction.usage, new Date());
      const proposals = Array.isArray(extraction.output?.proposals)
        ? extraction.output.proposals.filter((proposal) => proposal?.scope === "global")
        : [];
      const results = await applyPersonalMemoryProposals(CODEX_HOME, proposals, {
        threadId: thread.id,
        title: thread.title,
        source: thread.source,
      });
      const knowledgeProposals = await recordProjectAndSkillProposals(extraction.output, {
        threadId: thread.id,
        title: thread.title,
        source: thread.source,
      }, { codexHome: CODEX_HOME, workspaceRoot: path.resolve(REPO_ROOT, "..") });
      summary.processed += 1;
      for (const result of results) {
        if (result.action === "created") summary.created += 1;
        if (result.status === "confirmed") summary.confirmed += 1;
        if (result.status === "pending") {
          summary.pending += 1;
          pendingCreated += 1;
        }
      }
      const pendingKnowledge = knowledgeProposals.filter((change) => change.status === "pending").length;
      summary.pending += pendingKnowledge;
      summary.confirmed += knowledgeProposals.filter((change) => change.status === "auto_applied").length;
      pendingCreated += pendingKnowledge;
      runtime.threads[thread.id] = nextState;
    } catch (error) {
      summary.failed += 1;
      lastError = `${thread.title || thread.id}: ${error.message}`.slice(0, 2_000);
      const retryCount = Math.min(10, (threadState?.retryCount || 0) + 1);
      runtime.threads[thread.id] = {
        ...(threadState || {}),
        rolloutPath: thread.rolloutPath,
        updatedAtMs: thread.updatedAtMs,
        retryCount,
        nextRetryAt: new Date(Date.now() + Math.min(6 * 60 * 60_000, 15 * 60_000 * 2 ** (retryCount - 1))).toISOString(),
        lastError: error.message.slice(0, 2_000),
      };
      console.error(lastError);
    }
    await writePersonalMemoryRuntime(CODEX_HOME, runtime);
  }

  runtime.status = summary.failed ? "error" : "idle";
  runtime.lastSuccessAt = summary.failed ? runtime.lastSuccessAt : new Date().toISOString();
  runtime.lastError = lastError;
  runtime.consecutiveFailures = summary.failed ? runtime.consecutiveFailures + 1 : 0;
  runtime.lastRun = summary;
  if (lastError) addAlert(runtime, "worker-error", `记忆自动整理失败，将自动重试：${lastError}`);

  const usageAlert = usageAlertNeeded(runtime, new Date(), { tokens: USAGE_TOKEN_ALERT, runs: USAGE_RUN_ALERT });
  if (usageAlert) {
    const message = `今天记忆整理已运行 ${usageAlert.usage.runs} 次，约使用 ${usageAlert.total.toLocaleString()} tokens；未停止运行。`;
    runtime.usage.lastAlertedDay = usageAlert.day;
    addAlert(runtime, "usage", message);
    await pushHome("记忆整理用量提醒", message, "personal-memory-usage");
  }
  if (pendingCreated) {
    await pushHome(
      "有记忆需要你确认",
      `自动整理新增 ${pendingCreated} 条不确定、敏感或冲突记忆；有空时在 Agent 的记忆页审核即可。`,
      "personal-memory-review",
    );
  }
  if (summary.failed && runtime.consecutiveFailures >= 3) {
    await pushHome("记忆整理连续失败", lastError || "后台记忆整理已连续失败，请查看 Agent 记忆页。", "personal-memory-error");
  }
  await writePersonalMemoryRuntime(CODEX_HOME, runtime);
  console.log(JSON.stringify(summary));
}

function listEligibleThreads() {
  const database = latestStateDatabase();
  const sessionSettings = readAgentSessionSettings();
  const db = new DatabaseSync(database, { readOnly: true });
  try {
    return db
      .prepare(`
        SELECT id, title, source, cwd, rollout_path AS rolloutPath,
               COALESCE(updated_at_ms, updated_at * 1000) AS updatedAtMs
        FROM threads
        WHERE archived = 0
          AND source IN ('cli', 'vscode')
          AND agent_role IS NULL
        ORDER BY COALESCE(updated_at_ms, updated_at * 1000) ASC
      `)
      .all()
      .map((row) => {
        const routing = sessionSettings[row.id] || {};
        return {
          ...row,
          updatedAtMs: Number(row.updatedAtMs) || 0,
          memoryProjectMode: routing.memoryProjectMode === "manual" ? "manual" : "auto",
          memoryProjects: Array.isArray(routing.memoryProjects)
            ? routing.memoryProjects.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 20)
            : [],
        };
      });
  } finally {
    db.close();
  }
}

function readAgentSessionSettings() {
  try {
    const parsed = JSON.parse(process.getBuiltinModule("node:fs").readFileSync(AGENT_SESSION_SETTINGS_FILE, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function latestStateDatabase() {
  const files = fsSyncGlob(path.join(CODEX_HOME, "state_*.sqlite"));
  if (!files.length) throw new Error("No Codex state database found.");
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file;
}

function fsSyncGlob(pattern) {
  const directory = path.dirname(pattern);
  const matcher = new RegExp(`^${path.basename(pattern).replaceAll(".", "\\.").replaceAll("*", ".*")}$`);
  return requireDirectory(directory)
    .filter((name) => matcher.test(name))
    .map((name) => {
      const file = path.join(directory, name);
      return { file, mtimeMs: requireStat(file)?.mtimeMs || 0 };
    });
}

function requireDirectory(directory) {
  try {
    return process.getBuiltinModule("node:fs").readdirSync(directory);
  } catch {
    return [];
  }
}

function requireStat(file) {
  try {
    return process.getBuiltinModule("node:fs").statSync(file);
  } catch {
    return null;
  }
}

async function runExtraction(prompt) {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "personal-memory-"));
  const outputFile = path.join(tempDirectory, "output.json");
  const commandArgs = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--skip-git-repo-check",
    "-C",
    os.tmpdir(),
    "--output-schema",
    SCHEMA_FILE,
    "--json",
    "-o",
    outputFile,
    "-",
  ];
  try {
    const execution = await spawnCodex(commandArgs, prompt);
    if (execution.code !== 0) throw new Error(`Codex extraction exited ${execution.code}: ${execution.stderr.slice(-1_000)}`);
    const output = JSON.parse(await fs.readFile(outputFile, "utf8"));
    let usage = usageFromCodexEvents(execution.stdout);
    if (!usage.inputTokens && !usage.outputTokens) {
      usage = {
        inputTokens: Math.ceil(prompt.length / 4),
        outputTokens: Math.ceil(JSON.stringify(output).length / 4),
        estimated: true,
      };
    }
    return { output, usage };
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
}

function spawnCodex(commandArgs, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CODEX_COMMAND || "codex", commandArgs, {
      cwd: os.tmpdir(),
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, EXTRACTION_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-10_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-1_000_000);
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) reject(new Error(`Codex extraction was terminated (${signal}).`));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(prompt);
  });
}

async function pushHome(title, body, tag) {
  try {
    const response = await fetch(HOME_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "personal-memory", title, body, tag, url: "/" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Home push returned ${response.status}`);
  } catch (error) {
    console.error(`Home push failed: ${error.message}`);
  }
}

function addAlert(runtime, type, message) {
  runtime.alerts.push({ type, message, createdAt: new Date().toISOString() });
  runtime.alerts = runtime.alerts.slice(-20);
}

async function acquireWorkerLock() {
  await fs.mkdir(path.dirname(WORKER_LOCK), { recursive: true, mode: 0o700 });
  try {
    const handle = await fs.open(WORKER_LOCK, "wx", 0o600);
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    return handle;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const stat = await fs.stat(WORKER_LOCK).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 2 * 60 * 60_000) {
      await fs.unlink(WORKER_LOCK).catch(() => {});
      return acquireWorkerLock();
    }
    console.log("Personal memory worker is already running.");
    process.exit(0);
  }
}
