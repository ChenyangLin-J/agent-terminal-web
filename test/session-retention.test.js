import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const retentionMs = 2000;
const MESSAGE_TIMEOUT_MS = 15_000;

test("idle Session runtimes are released and renew only after meaningful input", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-session-retention-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let nextThread = 0;
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "thread/start" || message.method === "thread/resume") {
    const threadId = message.method === "thread/start"
      ? "019f9db5-cdfd-7c10-b477-4859c233" + (++nextThread).toString(16).padStart(4, "0")
      : String(message.params?.threadId || "");
    send({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
  } else if (message.method === "turn/start") {
    const threadId = String(message.params?.threadId || "");
    const turn = { id: "turn-" + threadId.slice(-4), status: "inProgress" };
    send({ id: message.id, result: { turn } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId, turn } });
    }, 10);
    setTimeout(() => {
      send({
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: "completed" } },
      });
    }, 2400);
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
      CODEX_APP_SERVER_COMMAND: fakeCodex,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      SESSION_TTL_MS: String(retentionMs),
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
  await waitFor(() => output.includes("Agent Terminal Web:"), MESSAGE_TIMEOUT_MS);

  // A reconnect alone is not meaningful activity: the idle lease expires anyway.
  const firstId = await startSession(agentPort, "first-client");
  await delay(300);
  await reconnectAndClose(agentPort, firstId, "reconnect-only");
  await waitFor(
    () => /"event":"session-runtime-release".*"reason":"idle-ttl"/.test(output),
    5_000,
  );
  assert.equal((await sessionEntry(agentPort, firstId))?.released, true, output);

  // A submitted prompt renews the lease and defers the release while a turn runs.
  const working = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=working-client`,
  );
  const workingStatus = await working.next(
    (message) => message.type === "status" && message.payload.ready,
    MESSAGE_TIMEOUT_MS,
  );
  working.ws.send(JSON.stringify({ type: "submit", data: "keep working while detached" }));
  await working.next(
    (message) => message.type === "control-ack" && message.payload.kind === "submit",
    MESSAGE_TIMEOUT_MS,
  );
  working.ws.close();
  await waitFor(() => working.ws.readyState === WebSocket.CLOSED, MESSAGE_TIMEOUT_MS);

  await waitFor(
    () => /"event":"runtime-release-deferred".*"reason":"active-work"/.test(output),
    5_000,
  );
  assert.notEqual((await sessionEntry(agentPort, workingStatus.payload.id))?.released, true, output);

  const completed = await fetch(`http://127.0.0.1:${agentPort}/internal/codex-notify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      webSessionId: workingStatus.payload.id,
      event: {
        type: "agent-turn-complete",
        "turn-id": "turn-working",
        "last-assistant-message": "Finished in the background.",
      },
    }),
  });
  assert.equal(completed.status, 200);

  // Once the App Server reports the turn as completed the release proceeds.
  await waitFor(
    async () => (await sessionEntry(agentPort, workingStatus.payload.id))?.released === true,
    6_000,
  );
});

async function startSession(port, clientId) {
  const client = await connect(
    `ws://127.0.0.1:${port}/terminal?cwd=.&transport=app-server&access=safe&clientId=${clientId}`,
  );
  const status = await client.next(
    (message) => message.type === "status" && message.payload.ready,
    MESSAGE_TIMEOUT_MS,
  );
  client.ws.close();
  await waitFor(() => client.ws.readyState === WebSocket.CLOSED, MESSAGE_TIMEOUT_MS);
  return status.payload.id;
}

async function reconnectAndClose(port, id, clientId) {
  const client = await connect(`ws://127.0.0.1:${port}/terminal?attach=${id}&clientId=${clientId}`);
  await client.next((message) => message.type === "status", MESSAGE_TIMEOUT_MS);
  await client.next((message) => message.type === "replay", MESSAGE_TIMEOUT_MS);
  client.ws.close();
  await waitFor(() => client.ws.readyState === WebSocket.CLOSED, MESSAGE_TIMEOUT_MS);
}

async function sessionEntry(port, id) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(response.status, 200);
  const data = await response.json();
  return data.sessions.find((session) => session.id === id);
}

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
    next(predicate, timeoutMs = 2000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`Timed out waiting for WebSocket message from ${url}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

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
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
