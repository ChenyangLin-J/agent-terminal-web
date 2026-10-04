import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const threadId = "11111111-1111-4111-8111-111111111111";

// Use temporary homes, a fake Codex process and local auth for every case.
// No test connects to the deployed Agent service or the user's Codex state.
for (const kernel of ["legacy", "all"]) {
  test(`old Terminal records resume structured history and continue turns (${kernel})`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-ui-slim-"));
    const codexHome = path.join(root, "codex");
    const workspaceRoot = path.join(root, "workspace");
    const callsFile = path.join(root, "calls.jsonl");
    const fakeCodex = path.join(root, "fake-codex.cjs");
    await Promise.all([mkdir(codexHome), mkdir(workspaceRoot)]);
    await writeFile(callsFile, "");
    await writeFile(path.join(codexHome, "agent-web-sessions.json"), JSON.stringify({
      "old-terminal": {
        id: "old-terminal", hostId: "personal", cwd: workspaceRoot,
        transport: "terminal", command: "codex", args: ["resume", threadId],
        access: "safe", mode: "resume-id", sessionId: threadId,
        title: "Old Terminal conversation", runtimeKernel: "legacy",
        startedAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(),
        turnState: { active: false, requirements: [], queuedTurns: [] },
      },
    }));
    await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
let turnNumber = 0;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  fs.appendFileSync(process.env.TEST_NATIVE_CALLS, JSON.stringify(message) + '\\n');
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'fake' };
  if (message.method === 'thread/resume') result = {
    thread: { id: message.params.threadId, turns: [] },
    initialTurnsPage: { data: [{ id: 'historic-turn', status: 'completed', items: [
      { id: 'historic-user', type: 'userMessage', content: [{ type: 'text', text: 'historic question' }] },
      { id: 'historic-answer', type: 'agentMessage', text: 'historic answer', phase: 'final_answer' },
    ] }], nextCursor: null },
  };
  if (message.method === 'thread/list') result = { data: [], nextCursor: null };
  if (message.method === 'turn/start') {
    const turn = { id: 'continued-turn-' + (++turnNumber), status: 'inProgress', items: [] };
    result = { turn };
    setTimeout(() => send({ method: 'turn/started', params: { threadId: message.params.threadId, turn } }), 10);
    setTimeout(() => {
      const item = { id: 'answer-' + turn.id, type: 'agentMessage', text: 'continued answer', phase: 'final_answer' };
      send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: turn.id, item } });
      send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { ...turn, status: 'completed', items: [item] } } });
    }, 40);
  }
  send({ id: message.id, result });
});
`);
    await chmod(fakeCodex, 0o755);

    let authRequests = 0;
    const authServer = http.createServer((_req, res) => {
      authRequests += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"authenticated":true}');
    });
    const authPort = await listen(authServer);
    const reservation = http.createServer();
    const agentPort = await listen(reservation);
    await new Promise((resolve) => reservation.close(resolve));
    const child = spawn(process.execPath, ["server.js"], {
      cwd: projectRoot,
      env: {
        ...process.env, HOST: "127.0.0.1", PORT: String(agentPort),
        CODEX_HOME: codexHome, WORKSPACE_ROOT: workspaceRoot,
        CODEX_APP_SERVER_COMMAND: fakeCodex, AGENT_NATIVE_THREAD_CATALOG: "0",
        AGENT_PLATFORM_KERNEL: kernel, SESSION_TTL_MS: "60000",
        PERSONAL_MEMORY_SETTLE_MS: "3600000",
        PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
        TEST_NATIVE_CALLS: callsFile,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    let socket;
    t.after(async () => {
      socket?.terminate();
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        await exited;
      }
      await new Promise((resolve) => authServer.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    await waitFor(() => output.includes("Agent Terminal Web:"), () => output);

    const origin = `http://127.0.0.1:${agentPort}`;
    const authBefore = authRequests;
    assert.equal((await fetch(`${origin}/api/hosts`)).status, 404);
    assert.ok(authRequests > authBefore, "404 must be observed after authentication");
    assert.equal((await fetch(`${origin}/api/projects`)).status, 200);
    const sessionsResponse = await fetch(`${origin}/api/sessions`);
    assert.equal(sessionsResponse.status, 200);
    const sessions = (await sessionsResponse.json()).sessions;
    assert.equal(sessions.find((session) => session.id === "old-terminal")?.transport, "app-server");

    const client = await connect(`ws://127.0.0.1:${agentPort}/terminal?attach=old-terminal`);
    socket = client.ws;
    const ready = await client.next((message) => message.type === "status" && message.payload.ready);
    assert.equal(ready.payload.transport, "app-server");
    assert.equal(ready.payload.runtimeKernel, kernel === "all" ? "platform" : "legacy");
    assert.equal(ready.payload.sessionId, threadId);
    const transcript = await client.next((message) => message.type === "app-transcript" &&
      JSON.stringify(message.payload).includes("historic answer"));
    assert.match(JSON.stringify(transcript.payload), /historic question/);

    for (const turn of [1, 2]) {
      client.ws.send(JSON.stringify({ type: "submit", data: `follow-up ${turn}`, deliveryMode: "queue" }));
      await client.next((message) => message.type === "control-ack" && message.payload.kind === "submit");
      await client.next((message) => message.type === "status" &&
        message.payload.turnState?.lastCompletedTurnId === `continued-turn-${turn}` &&
        !message.payload.turnState.active);
    }
    const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(JSON.parse);
    assert.ok(calls.some((call) => call.method === "thread/resume" && call.params.threadId === threadId));
    assert.equal(calls.filter((call) => call.method === "turn/start").length, 2);
    assert.equal(calls.filter((call) => call.method === "initialize").length, 1,
      "restoration and continued turns reuse one shared App Server process");
    const persisted = JSON.parse(await readFile(path.join(codexHome, "agent-web-sessions.json"), "utf8"));
    assert.equal(persisted["old-terminal"].transport, "app-server");
    assert.equal(persisted["old-terminal"].sessionId, threadId);
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function waitFor(predicate, details, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for test server:\n${details()}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((waiter) => waiter.predicate(message));
    if (index < 0) queue.push(message);
    else {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    }
  });
  await once(ws, "open");
  return {
    ws,
    next(predicate) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for WebSocket event; queued: ${JSON.stringify(queue)}`));
        }, 10000);
        waiters.push(waiter);
      });
    },
  };
}
