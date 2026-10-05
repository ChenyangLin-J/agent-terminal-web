import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db5-cdfd-7c10-b477-4859c23313be";
const turnId = "019f9db5-cdfd-7c10-b477-4859c23313bf";

test("platform kernel canary serves new sessions and force-legacy rolls them back", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-platform-canary-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  const requestLog = path.join(temporaryRoot, "requests.jsonl");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  require("node:fs").appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "model/list") {
    send({ id: message.id, result: { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "6.1", defaultReasoningEffort: "xhigh", supportedReasoningEfforts: [{ reasoningEffort: "xhigh" }] }, { id: "codex", model: "codex", defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] } });
  } else if (message.method === "config/read") {
    send({ id: message.id, result: { config: { model: "gpt-6.1-sol", model_reasoning_effort: "xhigh", model_context_window: 200000 } } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "${threadId}", turns: [] } } });
  } else if (message.method === "thread/resume") {
    send({
      id: message.id,
      result: {
        thread: { id: message.params.threadId, turns: [] },
        initialTurnsPage: { data: [], nextCursor: null }
      }
    });
  } else if (message.method === "turn/start") {
    const turn = { id: "${turnId}", status: "completed" };
    send({ id: message.id, result: { turn } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "${threadId}", turn } });
      send({ method: "thread/tokenUsage/updated", params: { threadId: "${threadId}", tokenUsage: { total: { totalTokens: 3000 }, last: { totalTokens: 2000 }, modelContextWindow: 200000 } } });
      send({ method: "turn/completed", params: { threadId: "${threadId}", turn } });
    }, 10);
  } else if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`,
  );
  await chmod(fakeCodex, 0o755);

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  t.after(() => authServer.close());
  const authPort = authServer.address().port;

  const spawnServer = async (platformKernel) => {
    const agentPort = await reservePort();
    const child = spawn(process.execPath, ["server.js"], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: String(agentPort),
        CODEX_HOME: codexHome,
        WORKSPACE_ROOT: workspaceRoot,
        CODEX_APP_SERVER_COMMAND: fakeCodex,
        AGENT_NATIVE_THREAD_CATALOG: "0",
        SESSION_TTL_MS: "1200",
        AGENT_PLATFORM_KERNEL: platformKernel,
        PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    await waitFor(() => output.includes("Agent Terminal Web:"), 5_000);
    return { child, agentPort, getOutput: () => output };
  };

  const canary = await spawnServer("new");
  t.after(async () => {
    if (canary.child.exitCode === null) canary.child.kill("SIGTERM");
  });

  const metadata = await (await fetch(`http://127.0.0.1:${canary.agentPort}/api/platform/session-metadata?cwd=.`)).json();
  assert.equal(metadata.currentModel, 'gpt-6.1-sol'); assert.equal(metadata.currentReasoningEffort, 'xhigh');
  assert.equal((await (await fetch(`http://127.0.0.1:${canary.agentPort}/api/sessions`)).json()).sessions.length, 0);
  assert.equal((await readFile(requestLog, 'utf8')).includes('thread/start'), false);

  const client = await connect(
    `ws://127.0.0.1:${canary.agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=platform-canary`,
  );
  const ready = await client
    .next((message) => message.type === "status" && message.payload.ready, 15_000)
    .catch((error) => {
      throw new Error(`${error.message}\n--- server output ---\n${canary.getOutput()}`);
    });
  assert.equal(ready.payload.runtimeKernel, "platform");
  assert.equal(ready.payload.sessionId, threadId);
  assert.match(canary.getOutput(), /"event":"session-start".*"runtimeKernel":"platform"/);

  const profileResponse = await fetch(`http://127.0.0.1:${canary.agentPort}/api/platform/sessions/${ready.payload.id}/actions/executionProfile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'codex', reasoningEffort: 'medium', accessMode: 'full', serviceTier: 'priority', idempotencyKey: 'canary-profile' }) });
  assert.equal(profileResponse.status, 200);
  const projected = await (await fetch(`http://127.0.0.1:${canary.agentPort}/api/platform/sessions/${ready.payload.id}`)).json();
  assert.equal(projected.session.model, 'codex'); assert.equal(projected.session.reasoningEffort, 'medium');

  client.ws.send(JSON.stringify({ type: "submit", data: "hello platform kernel" }));
  await client.next(
    (message) => message.type === "control-ack" && message.payload.kind === "submit",
    3_000,
  );
  const completed = await client.next(
    (message) =>
      message.type === "status" &&
      message.payload.turnState?.lastCompletedTurnId === turnId,
    5_000,
  );
  assert.equal(completed.payload.runtimeKernel, "platform");
  const context = await (await fetch(`http://127.0.0.1:${canary.agentPort}/api/platform/sessions/${ready.payload.id}/actions/readContext`)).json();
  assert.equal(context.tokenUsage.contextUsedTokens, 2000); assert.equal(context.tokenUsage.modelContextWindow, 200000);
  const starts = (await readFile(requestLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(message => message.method === 'turn/start');
  assert.equal(starts[0].params.model, 'codex'); assert.equal(starts[0].params.effort, 'medium'); assert.equal(starts[0].params.serviceTier, 'priority');


  const released = await client.next(
    (message) => message.type === "status" && message.payload.released,
    5_000,
  );
  assert.equal(released.payload.releaseReason, "idle-ttl");
  assert.equal(released.payload.runtimeKernel, "platform");
  client.ws.close();

  const detachedList = await (
    await fetch(`http://127.0.0.1:${canary.agentPort}/api/sessions`)
  ).json();
  const detachedItem = detachedList.sessions.find(
    (session) => session.id === ready.payload.id,
  );
  assert.equal(detachedItem?.runtimeKernel, "platform");

  const bindings = JSON.parse(
    await readFile(path.join(codexHome, "agent-web-platform-bindings.json"), "utf8"),
  );
  assert.ok(Object.keys(bindings).length >= 1);

  const webSessionId = ready.payload.id;
  await new Promise((resolve) => {
    canary.child.once("exit", resolve);
    canary.child.kill("SIGTERM");
  });

  const rollback = await spawnServer("legacy");
  t.after(async () => {
    if (rollback.child.exitCode === null) rollback.child.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const rollbackList = await (
    await fetch(`http://127.0.0.1:${rollback.agentPort}/api/sessions`)
  ).json();
  const rollbackDetached = rollbackList.sessions.find(
    (session) => session.id === webSessionId,
  );
  assert.equal(rollbackDetached?.runtimeKernel, "legacy");

  const rollbackClient = await connect(
    `ws://127.0.0.1:${rollback.agentPort}/terminal?cwd=.&transport=app-server&access=safe` +
      `&clientId=legacy-rollback&attach=${webSessionId}`,
  );
  const rolledBack = await rollbackClient.next(
    (message) => message.type === "status" && message.payload.ready,
    5_000,
  );
  assert.equal(rolledBack.payload.runtimeKernel, "legacy");
  assert.equal(rolledBack.payload.sessionId, threadId);
  const legacyContext = await (await fetch(`http://127.0.0.1:${rollback.agentPort}/api/platform/sessions/${webSessionId}`)).json();
  assert.equal(legacyContext.session.model, 'codex'); assert.equal(legacyContext.session.reasoningEffort, 'medium');
  assert.equal(legacyContext.session.serviceTier, 'priority');

  rollbackClient.ws.close();
});

async function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    next(predicate, timeoutMs = 2_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`Timed out waiting for ${url}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for isolated Agent Web");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
