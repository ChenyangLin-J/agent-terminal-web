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
const retentionMs = 800;

test("detached retention survives reconnects and renews only after meaningful input", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-session-retention-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
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
      CODEX_COMMAND: fakeCodex,
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
  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);

  const firstId = await startSession(agentPort, "first-client");
  await delay(300);
  await reconnectAndClose(agentPort, firstId, "reconnect-only");
  await delay(600);
  assert.equal(await sessionIsLive(agentPort, firstId), false, output);

  const second = await connect(`ws://127.0.0.1:${agentPort}/terminal?cwd=.&clientId=second-client`);
  const secondStatus = await second.next((message) => message.type === "status");
  await second.next((message) => message.type === "replay");
  second.ws.close();
  await waitFor(() => second.ws.readyState === WebSocket.CLOSED, 1000);
  await delay(300);

  const active = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?attach=${secondStatus.payload.id}&clientId=meaningful-input`,
  );
  await active.next((message) => message.type === "status");
  await active.next((message) => message.type === "replay");
  active.ws.send(JSON.stringify({ type: "input", data: "x" }));
  await active.next((message) => message.type === "control-ack" && message.payload.kind === "input");
  active.ws.close();
  await waitFor(() => active.ws.readyState === WebSocket.CLOSED, 1000);

  await delay(600);
  assert.equal(await sessionIsLive(agentPort, secondStatus.payload.id), true, output);
  await delay(300);
  assert.equal(await sessionIsLive(agentPort, secondStatus.payload.id), false, output);

  const working = await connect(`ws://127.0.0.1:${agentPort}/terminal?cwd=.&clientId=working-client`);
  const workingStatus = await working.next((message) => message.type === "status");
  await working.next((message) => message.type === "replay");
  working.ws.send(JSON.stringify({ type: "submit", data: "keep working while detached" }));
  await working.next((message) => message.type === "control-ack" && message.payload.kind === "submit");
  working.ws.close();
  await waitFor(() => working.ws.readyState === WebSocket.CLOSED, 1000);

  await delay(retentionMs + 200);
  assert.equal(await sessionIsLive(agentPort, workingStatus.payload.id), true, output);
  assert.match(output, /"event":"cleanup-deferred".*"reason":"active-work"/);

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

  await delay(600);
  assert.equal(await sessionIsLive(agentPort, workingStatus.payload.id), true, output);
  await delay(300);
  assert.equal(await sessionIsLive(agentPort, workingStatus.payload.id), false, output);
});

async function startSession(port, clientId) {
  const client = await connect(`ws://127.0.0.1:${port}/terminal?cwd=.&clientId=${clientId}`);
  const status = await client.next((message) => message.type === "status");
  await client.next((message) => message.type === "replay");
  client.ws.close();
  await waitFor(() => client.ws.readyState === WebSocket.CLOSED, 1000);
  return status.payload.id;
}

async function reconnectAndClose(port, id, clientId) {
  const client = await connect(`ws://127.0.0.1:${port}/terminal?attach=${id}&clientId=${clientId}`);
  await client.next((message) => message.type === "status");
  await client.next((message) => message.type === "replay");
  client.ws.close();
  await waitFor(() => client.ws.readyState === WebSocket.CLOSED, 1000);
}

async function sessionIsLive(port, id) {
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`);
  assert.equal(response.status, 200);
  const data = await response.json();
  return data.sessions.some((session) => session.id === id);
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
    if (predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
