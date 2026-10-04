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
const mainThreadId = "019f9db5-cdfd-7c10-b477-4859c23313d0";
const sideThreadId = "019f9db5-cdfd-7c10-b477-4859c23313d1";

test("side chat creates an ephemeral read-only fork without deferGoalContinuation and sends its prompt", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-side-chat-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const callsFile = path.join(temporaryRoot, "calls.jsonl");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(process.env.TEST_NATIVE_CALLS, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "${mainThreadId}", turns: [] } } });
  } else if (message.method === "thread/fork") {
    if (message.params.ephemeral && message.params.deferGoalContinuation) {
      send({ id: message.id, error: { message: "deferGoalContinuation cannot be combined with ephemeral" } });
      return;
    }
    send({ id: message.id, result: { thread: { id: "${sideThreadId}", turns: [] } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "side-turn", status: "inProgress", items: [] } } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "side-turn", status: "inProgress" } } });
      send({ method: "item/completed", params: { threadId: message.params.threadId, item: { id: "side-answer", type: "agentMessage", text: "Side answer" } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "side-turn", status: "completed" } } });
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
  const agentPort = await reservePort();
  const agent = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      CODEX_APP_SERVER_COMMAND: fakeCodex,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      AGENT_PLATFORM_KERNEL: "legacy",
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authServer.address().port}`,
      TEST_NATIVE_CALLS: callsFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  agent.stdout.on("data", (chunk) => (output += chunk));
  agent.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (agent.exitCode === null) agent.kill("SIGTERM");
    await new Promise((resolve) => authServer.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 5_000);

  const client = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=side-chat-test`,
  );
  t.after(() => client.ws.close());
  await client.next((message) => message.type === "status" && message.payload.ready && message.payload.sessionId === mainThreadId);

  client.ws.send(JSON.stringify({ type: "side-chat-submit", data: "Summarize the main task." }));
  const acknowledgement = await client.next(
    (message) => message.type === "control-ack" && message.payload.kind === "side-chat-submit",
  );
  assert.equal(acknowledgement.payload.threadId, sideThreadId);
  await client.next(
    (message) => message.type === "side-chat-state" && message.payload.items.some((item) => item.text === "Side answer"),
  );

  const calls = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const fork = calls.find((call) => call.method === "thread/fork");
  assert.ok(fork, "side chat must create a fork through the app-server request boundary");
  assert.equal(fork.params.threadId, mainThreadId);
  assert.equal(fork.params.ephemeral, true);
  assert.equal(fork.params.sandbox, "read-only");
  assert.equal(fork.params.approvalPolicy, "never");
  assert.equal(fork.params.excludeTurns, true);
  assert.equal(fork.params.deferGoalContinuation, undefined);
  const turn = calls.find((call) => call.method === "turn/start" && call.params.threadId === sideThreadId);
  assert.equal(turn.params.input[0].text, "Summarize the main task.");
});

async function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      queue.push(message);
    }
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    next(predicate, timeout = 5_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for WebSocket message; queued: ${JSON.stringify(queue)}`)),
          timeout,
        );
        waiters.push({ predicate, resolve, timer });
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

async function waitFor(predicate, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}
