import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db4-cdfd-7c10-b477-4859c23313be";
const runningThreadId = "019f9db4-cdfd-7c10-b477-4859c23313bf";
const pausedThreadId = "019f9db4-cdfd-7c10-b477-4859c23313c0";
const legacyThreadId = "019f9db4-cdfd-7c10-b477-4859c23313c1";
const turnId = "019f9db5-cdfd-7c10-b477-4859c23313be";

test("Agent Web restart preserves Session workflow state separately from runtime state", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-session-state-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "agent-web-sessions.json"),
    `${JSON.stringify({
      "current-session": {
        id: "current-session",
        cwd: workspaceRoot,
        command: "codex",
        args: ["app-server"],
        transport: "app-server",
        access: "safe",
        mode: "resume-id",
        sessionId: threadId,
        title: "Keep me current",
        startedAt: "2026-07-20T10:00:00.000Z",
        lastActivityAt: "2026-07-20T10:10:00.000Z",
        detachedAt: "2026-07-20T10:10:00.000Z",
        released: false,
        turnState: {
          active: false,
          lastCompletedTurnId: turnId,
          requirements: [],
          queuedTurns: [],
        },
      },
      "running-session": {
        id: "running-session",
        cwd: workspaceRoot,
        command: "codex",
        args: ["app-server"],
        transport: "app-server",
        access: "safe",
        mode: "resume-id",
        sessionId: runningThreadId,
        title: "Needs continuation after restart",
        startedAt: "2026-07-20T10:00:00.000Z",
        lastActivityAt: "2026-07-20T10:11:00.000Z",
        detachedAt: "2026-07-20T10:11:00.000Z",
        released: false,
        turnState: {
          active: true,
          turnId,
          requirements: [{ id: "requirement-1", text: "完成重启前的任务", kind: "original", status: "working" }],
          queuedTurns: [],
        },
      },
      "paused-session": {
        id: "paused-session",
        cwd: workspaceRoot,
        command: "codex",
        args: ["app-server"],
        transport: "app-server",
        access: "safe",
        mode: "resume-id",
        sessionId: pausedThreadId,
        title: "Actually paused",
        startedAt: "2026-07-20T10:00:00.000Z",
        lastActivityAt: "2026-07-20T10:09:00.000Z",
        detachedAt: "2026-07-20T10:09:00.000Z",
        released: true,
        releaseReason: "detached-ttl",
        turnState: { active: false, requirements: [], queuedTurns: [] },
      },
      "legacy-session": {
        id: "legacy-session",
        cwd: workspaceRoot,
        command: "codex",
        args: ["app-server"],
        transport: "app-server",
        access: "safe",
        mode: "resume-id",
        sessionId: legacyThreadId,
        title: "Legacy restart state",
        startedAt: "2026-07-20T10:00:00.000Z",
        lastActivityAt: "2026-07-20T10:08:00.000Z",
        detachedAt: "2026-07-20T10:08:00.000Z",
        released: true,
        turnState: { active: false, requirements: [], queuedTurns: [] },
      },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(codexHome, "agent-session-settings.json"),
    `${JSON.stringify({
      [threadId]: {
        access: "safe",
        lastCompletedTurnId: turnId,
        lastCompletedAt: "2026-07-20T10:10:00.000Z",
      },
    }, null, 2)}\n`,
  );

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  const authPort = await listen(authServer);
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);

  const sessionsResponse = await fetch(`http://127.0.0.1:${agentPort}/api/sessions`);
  assert.equal(sessionsResponse.status, 200);
  const sessions = (await sessionsResponse.json()).sessions;
  assert.equal(sessions.length, 4);
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const current = sessionsById.get("current-session");
  assert.equal(current.released, false);
  assert.equal(current.suspended, true);
  assert.equal(current.ready, true);
  assert.equal(current.hasUnreadResult, true);

  const running = sessionsById.get("running-session");
  assert.equal(running.released, false);
  assert.equal(running.suspended, true);
  assert.equal(running.ready, true);
  assert.equal(running.turnState.active, false);
  assert.equal(running.turnState.interrupted, true);
  assert.equal(running.turnState.requirements[0].status, "interrupted");

  const paused = sessionsById.get("paused-session");
  assert.equal(paused.released, true);
  assert.equal(paused.suspended, true);
  assert.equal(paused.ready, false);

  const legacy = sessionsById.get("legacy-session");
  assert.equal(legacy.released, false);
  assert.equal(legacy.suspended, true);
  assert.equal(legacy.ready, true);

  const viewedResponse = await fetch(
    `http://127.0.0.1:${agentPort}/api/codex-sessions/${threadId}/viewed`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId }),
    },
  );
  assert.equal(viewedResponse.status, 200);
  assert.equal((await viewedResponse.json()).hasUnreadResult, false);

  const settings = JSON.parse(await readFile(path.join(codexHome, "agent-session-settings.json"), "utf8"));
  assert.equal(settings[threadId].lastViewedTurnId, turnId);
  const persisted = JSON.parse(await readFile(path.join(codexHome, "agent-web-sessions.json"), "utf8"));
  assert.equal(persisted["current-session"].released, false);
  assert.equal(persisted["running-session"].released, false);
  assert.equal(persisted["paused-session"].released, true);
  assert.equal(persisted["paused-session"].releaseReason, "detached-ttl");
  assert.equal(persisted["legacy-session"].released, false);
  assert.equal(persisted["legacy-session"].releaseReason, undefined);
});

test("threadless shared App Server notifications cannot refresh every Session timestamp", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(
    server,
    /if \(notificationThreadId && session\.sessionId && notificationThreadId !== session\.sessionId\) return;\s+if \(notificationThreadId\) session\.lastActivityAt = new Date\(\)\.toISOString\(\);/,
  );
  assert.doesNotMatch(
    server,
    /const \{ method, params = \{\} \} = message;\s+session\.lastActivityAt = new Date\(\)\.toISOString\(\);/,
  );
});

test("the control center separates execution, reading, and resource state", async () => {
  const [app, page] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);
  assert.match(page, /data-summary-filter="unread"[\s\S]*新结果/);
  assert.match(page, /data-summary-filter="ready"[\s\S]*空闲/);
  assert.match(app, /session\?\.hasUnreadResult[\s\S]*kind: "unread"[\s\S]*label: "新结果"/);
  assert.match(app, /kind: "ready", state: "waiting", label: "空闲"/);
  assert.match(app, /sessionScreen\.classList\.contains\("hidden"\)/);
  assert.match(app, /document\.visibilityState !== "visible"/);
  assert.match(app, /activeTransport === "app-server"\s+\? isAppTranscriptAtBottom\(\)/);
  assert.match(app, /activeTransport === "terminal" && !historySyncPending && isTerminalAtBottom\(\)/);
  assert.match(app, /\/api\/codex-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/viewed/);
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
