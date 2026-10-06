import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db5-cdfd-7c10-b477-4859c2330001";

test("Home turns accept vault capture images as localImage input and reject invalid attachments", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "home-turn-attachments-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "saved-project");
  const vaultAttachments = path.join(workspaceRoot, "obsidian/MainVault/System/Capture/Attachments/2026-10-06");
  const codexStateRoot = path.join(temporaryRoot, "state");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  const fakeCalls = path.join(temporaryRoot, "fake-calls.jsonl");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(vaultAttachments, { recursive: true });
  await mkdir(codexStateRoot, { recursive: true });
  await writeFile(path.join(vaultAttachments, "capture.png"), "png-bytes");
  await writeFile(path.join(vaultAttachments, "voice.m4a"), "audio-bytes");
  await writeFile(fakeCodex, fakeAppServer());
  await chmod(fakeCodex, 0o755);
  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      WORKSPACE_ROOT: workspaceRoot,
      OBSIDIAN_VAULT_PATH: path.join(workspaceRoot, "obsidian/MainVault"),
      PRIVATE_AUTH_VERIFY_URL: "http://127.0.0.1:9/disabled-auth",
      AGENT_CODEX_STATE_ROOT: codexStateRoot,
      AGENT_MEMORY_SYSTEM_ROOT: process.env.AGENT_MEMORY_SYSTEM_ROOT,
      AGENT_PLATFORM_CANDIDATE: process.env.AGENT_PLATFORM_CANDIDATE,
      AGENT_PLATFORM_KERNEL: "legacy",
      AGENT_INTEGRATIONS_DIR: path.join(temporaryRoot, "integrations"),
      AGENT_CUBOX_CONFIG_DIR: path.join(temporaryRoot, "cubox"),
      CODEX_APP_SERVER_COMMAND: fakeCodex,
      AGENT_NATIVE_THREAD_CATALOG: "1",
      HOME_AGENT_GATEWAY_TOKEN: "gateway-test-token",
      HOME_PUSH_URL: "http://127.0.0.1:9/disabled-home-push",
      HOME_PUSH_SUBSCRIBE_URL: "http://127.0.0.1:9/disabled-home-push/subscriptions",
      FAKE_CALLS_FILE: fakeCalls,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("exit", (code) => { if (code) process.stderr.write(`Fixture exited (${code}): ${output}\n`); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Fixture Agent server exited: ${output}`);
    return output.includes("Agent Terminal Web:");
  });

  const accepted = await homeFetch(port, "/api/home/agent/turns", {
    method: "POST",
    body: {
      sessionId: threadId,
      text: "看看这张图里记了什么",
      requestId: "home-attach-001",
      attachments: [{ path: "System/Capture/Attachments/2026-10-06/capture.png" }],
    },
  });
  assert.equal(accepted.status, 202, await accepted.clone().text());
  await waitFor(async () => (await turnStartInputs(fakeCalls)).length === 1);
  const [input] = await turnStartInputs(fakeCalls);
  const imageItems = input.filter((item) => item.type === "localImage");
  assert.deepEqual(imageItems, [{ type: "localImage", path: realpathSync(path.join(vaultAttachments, "capture.png")) }]);
  assert.ok(input.some((item) => item.type === "text" && item.text.includes("看看这张图里记了什么")));

  const replay = await homeFetch(port, "/api/home/agent/turns", {
    method: "POST",
    body: {
      sessionId: threadId,
      text: "看看这张图里记了什么",
      requestId: "home-attach-001",
      attachments: [{ path: "System/Capture/Attachments/2026-10-06/capture.png" }],
    },
  });
  assert.equal(replay.status, 202);
  assert.equal((await turnStartInputs(fakeCalls)).length, 1, "an identical replay does not start another turn");

  await new Promise((resolve) => setTimeout(resolve, 80));
  const rejected = [
    ["home-attach-002", [{ path: "../2026-10-06/capture.png" }]],
    ["home-attach-003", [{ path: "System/Capture/Attachments/2026-10-06/voice.m4a" }]],
    ["home-attach-004", [{ path: "System/Capture/Attachments/2026-10-06/missing.png" }]],
    ["home-attach-005", "System/Capture/Attachments/2026-10-06/capture.png"],
  ];
  for (const [requestId, attachments] of rejected) {
    const response = await homeFetch(port, "/api/home/agent/turns", {
      method: "POST",
      body: { sessionId: threadId, text: "这条不应该提交", requestId, attachments },
    });
    assert.equal(response.status, 400, `${requestId}: ${await response.clone().text()}`);
    assert.ok((await response.json()).error);
  }
  assert.equal((await turnStartInputs(fakeCalls)).length, 1, "rejected attachments never reach turn/start");

  const emptyList = await homeFetch(port, "/api/home/agent/turns", {
    method: "POST",
    body: { sessionId: threadId, text: "没有附件的一轮", requestId: "home-attach-006", attachments: [] },
  });
  assert.equal(emptyList.status, 202, await emptyList.clone().text());
  await waitFor(async () => (await turnStartInputs(fakeCalls)).length === 2);
  const [, plainInput] = await turnStartInputs(fakeCalls);
  assert.equal(plainInput.filter((item) => item.type === "localImage").length, 0);

  const ledger = JSON.parse(await readFile(path.join(codexStateRoot, "home-agent-turn-requests.json"), "utf8"));
  assert.match(ledger["home-attach-001"].fingerprint, /capture\.png/);
  assert.equal(ledger["home-attach-006"].fingerprint.includes("attachments"), false);
});

function fakeAppServer() {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const threadId = "${threadId}";
const input = readline.createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const record = (line) => fs.appendFileSync(process.env.FAKE_CALLS_FILE, line + "\\n");
const history = [{ id: "019f9db5-cdfd-7c10-b477-4859c2330000", status: "completed", startedAt: 1, items: [
  { type: "userMessage", content: [{ type: "text", text: "earlier question" }] },
  { type: "agentMessage", phase: "final_answer", text: "earlier answer" }
] }];
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "thread/list") return send({ id: message.id, result: { data: [{ id: threadId, name: "Saved thread", cwd: process.env.WORKSPACE_ROOT + "/saved-project", updatedAt: 2, createdAt: 1, status: "idle" }] } });
  if (message.method === "thread/turns/list") return send({ id: message.id, result: { data: history } });
  if (message.method === "thread/resume") return send({ id: message.id, result: { thread: { id: threadId, turns: [] }, initialTurnsPage: { data: history } } });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
  if (message.method === "turn/start") {
    record("turn/start-input:" + JSON.stringify(message.params.input));
    const turn = { id: "019f9db5-cdfd-7c10-b477-4859c2330" + String(Date.now() % 1000).padStart(3, "0"), status: "inProgress" };
    send({ id: message.id, result: { turn } });
    return setTimeout(() => send({ method: "turn/completed", params: { threadId, turn: { ...turn, status: "completed" } } }), 40);
  }
  if (message.id !== undefined) send({ id: message.id, result: {} });
});
`;
}

function homeFetch(port, pathName, { method = "GET", body } = {}) {
  return fetch(`http://127.0.0.1:${port}${pathName}`, {
    method,
    headers: {
      "x-home-agent-gateway-token": "gateway-test-token",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent Web test server");
}

async function turnStartInputs(file) {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("turn/start-input:"))
      .map((line) => JSON.parse(line.slice("turn/start-input:".length)));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
