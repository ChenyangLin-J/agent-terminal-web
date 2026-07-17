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

test("reconnecting clients receive only terminal output after their saved revision", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-session-replay-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
setTimeout(() => process.stdout.write("first-marker\\r\\n"), 80);
setTimeout(() => process.stdout.write("second-marker\\r\\n"), 400);
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

  const first = await connect(`ws://127.0.0.1:${agentPort}/terminal?cwd=.&clientId=first-client`);
  const status = await first.next((message) => message.type === "status");
  await first.next((message) => message.type === "replay");
  const firstOutput = await first.next(
    (message) => message.type === "output" && message.payload.raw.includes("first-marker"),
  );
  const savedRevision = firstOutput.payload.revision;
  first.ws.close();
  await waitFor(() => first.ws.readyState === WebSocket.CLOSED, 1000);
  await delay(500);

  const resumed = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?attach=${status.payload.id}&clientId=second-client&afterRevision=${savedRevision}`,
  );
  const delta = await resumed.next((message) => message.type === "replay");
  assert.equal(delta.payload.mode, "delta");
  assert.equal(delta.payload.fromRevision, savedRevision);
  assert.ok(delta.payload.revision > savedRevision);
  assert.match(delta.payload.raw, /second-marker/);
  assert.doesNotMatch(delta.payload.raw, /first-marker/);
  assert.equal("text" in delta.payload, false);
  resumed.ws.close();

  const fallback = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?attach=${status.payload.id}&clientId=third-client&afterRevision=999999`,
  );
  const full = await fallback.next((message) => message.type === "replay");
  assert.equal(full.payload.mode, "full");
  assert.match(full.payload.raw, /first-marker/);
  assert.match(full.payload.raw, /second-marker/);
  assert.ok(Buffer.byteLength(full.payload.raw, "utf8") <= 32 * 1024);
  fallback.ws.send(JSON.stringify({ type: "kill" }));
  fallback.ws.close();
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
