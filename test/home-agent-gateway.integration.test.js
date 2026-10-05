import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db5-cdfd-7c10-b477-4859c2330001";

for (const kernelMode of ["legacy", "new"]) {
test(`Home adapter keeps durable thread identity, exposes history, and rejects duplicate busy sends (${kernelMode})`, async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "home-agent-adapter-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "saved-project");
  const codexStateRoot = path.join(temporaryRoot, "state");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  const fakeCalls = path.join(temporaryRoot, "fake-calls.jsonl");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await mkdir(codexStateRoot, { recursive: true });
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
      AGENT_PLATFORM_KERNEL: kernelMode,
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
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => {
    if (child.exitCode !== null) throw new Error(`Fixture Agent server exited: ${output}`);
    return output.includes("Agent Terminal Web:");
  });

  const denied = await fetch(`http://127.0.0.1:${port}/api/home/agent/sessions`);
  assert.equal(denied.status, 404);

  const sessions = await homeFetch(port, "/api/home/agent/sessions");
  assert.equal(sessions.status, 200);
  assert.equal((await sessions.json()).sessions[0].id, threadId);

  const conversation = await homeFetch(port, `/api/home/agent/conversation?sessionId=${threadId}`);
  assert.equal(conversation.status, 200);
  const history = await conversation.json();
  assert.deepEqual(history.messages.map((message) => [message.role, message.text]), [
    ["user", "earlier question"], ["assistant", "earlier answer"],
  ]);
  assert.equal(history.session.id, threadId);
  assert.equal(history.session.webSessionId, "");

  const mismatchedAttach = await homeFetch(
    port,
    `/api/home/agent/conversation?sessionId=${threadId}&attach=missing-web-session`,
  );
  assert.equal(mismatchedAttach.status, 409);

  const body = { sessionId: threadId, text: "continue from that answer", requestId: "home-request-001" };
  const [accepted, sameRequestReplay] = await Promise.all([
    homeFetch(port, "/api/home/agent/turns", { method: "POST", body }),
    homeFetch(port, "/api/home/agent/turns", { method: "POST", body }),
  ]);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal(sameRequestReplay.status, 202, await sameRequestReplay.clone().text());
  const acceptedPayload = await accepted.json();
  assert.deepEqual(await sameRequestReplay.json(), acceptedPayload);
  assert.equal(acceptedPayload.session.id, threadId);
  assert.equal(acceptedPayload.session.runtimeKernel, kernelMode === "new" ? "platform" : "legacy");
  assert.ok(acceptedPayload.session.webSessionId);
  assert.equal(acceptedPayload.turn.active, true);
  assert.match(await readFile(fakeCalls, "utf8"), new RegExp(`thread/resume-cwd:${projectRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const requestLedger = JSON.parse(await readFile(path.join(codexStateRoot, "home-agent-turn-requests.json"), "utf8"));
  assert.equal(requestLedger[body.requestId].payload.session.id, threadId);

  const replay = await homeFetch(port, "/api/home/agent/turns", { method: "POST", body });
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), acceptedPayload);

  await waitFor(async () => (await callCount(fakeCalls, "turn/start")) === 1);
  assert.equal(await callCount(fakeCalls, "thread/resume"), 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const afterCompletionReplay = await homeFetch(port, "/api/home/agent/turns", { method: "POST", body });
  assert.equal(afterCompletionReplay.status, 202);
  assert.equal(await callCount(fakeCalls, "turn/start"), 1);
  const [firstDistinct, secondDistinct] = await Promise.all([
    homeFetch(port, "/api/home/agent/turns", {
      method: "POST", body: { ...body, requestId: "home-request-002", text: "a second turn" },
    }),
    homeFetch(port, "/api/home/agent/turns", {
      method: "POST", body: { ...body, requestId: "home-request-003", text: "a competing turn" },
    }),
  ]);
  const distinctResponses = [firstDistinct, secondDistinct];
  assert.deepEqual(distinctResponses.map((response) => response.status).sort(), [202, 409]);
  assert.equal(await callCount(fakeCalls, "turn/start"), 2);
  const loser = firstDistinct.status === 409
    ? { ...body, requestId: "home-request-002", text: "a second turn" }
    : { ...body, requestId: "home-request-003", text: "a competing turn" };
  await new Promise((resolve) => setTimeout(resolve, 80));
  const loserRetry = await homeFetch(port, "/api/home/agent/turns", { method: "POST", body: loser });
  assert.equal(loserRetry.status, 202, "a known pre-submission failure can retry the same requestId");
  assert.equal(await callCount(fakeCalls, "turn/start"), 3);

  const mismatchedTurn = await homeFetch(port, "/api/home/agent/turns", {
    method: "POST",
    body: { ...body, requestId: "home-request-004", attach: "missing-web-session" },
  });
  assert.equal(mismatchedTurn.status, 409);
  const finalLedger = JSON.parse(await readFile(path.join(codexStateRoot, "home-agent-turn-requests.json"), "utf8"));
  assert.equal(finalLedger["home-request-004"], undefined, "attach mismatch did not attempt submission");
});
}

function fakeAppServer() {
  return `#!/usr/bin/env node
const readline = require("node:readline");
const threadId = "${threadId}";
const input = readline.createInterface({ input: process.stdin });
const fs = require("node:fs");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let turnNumber = 2;
const record = (method) => fs.appendFileSync(process.env.FAKE_CALLS_FILE, method + "\\n");
const history = [{ id: "019f9db5-cdfd-7c10-b477-4859c2330000", status: "completed", startedAt: 1, items: [
  { type: "userMessage", content: [{ type: "text", text: "earlier question" }] },
  { type: "agentMessage", phase: "final_answer", text: "earlier answer" }
] }];
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "thread/list") return send({ id: message.id, result: { data: [{ id: threadId, name: "Saved thread", cwd: process.env.WORKSPACE_ROOT + "/saved-project", updatedAt: 2, createdAt: 1, status: "idle" }] } });
  if (message.method === "thread/turns/list") return send({ id: message.id, result: { data: history } });
  if (message.method === "thread/resume") { record(message.method); record("thread/resume-cwd:" + message.params.cwd); return send({ id: message.id, result: { thread: { id: threadId, turns: [] }, initialTurnsPage: { data: history } } }); }
  if (message.method === "thread/start") { record(message.method); return send({ id: message.id, result: { thread: { id: threadId, turns: [] } } }); }
  if (message.method === "turn/start") {
    record(message.method);
    const turn = { id: "019f9db5-cdfd-7c10-b477-4859c233" + String(turnNumber++).padStart(4, "0"), status: "inProgress" };
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

async function callCount(file, method) {
  try {
    return (await readFile(file, "utf8")).split("\n").filter((line) => line === method).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}
