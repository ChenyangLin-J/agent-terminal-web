import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { MediaSessionAutoArchiveStore } from "../lib/session-auto-archive.js";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const idleMs = 350;
const ids = Array.from({ length: 8 }, (_, index) =>
  "11111111-1111-4111-8111-" + String(index + 1).padStart(12, "0"));

// All server processes, Codex processes and metadata in this suite are isolated
// from the running service and the user's Codex home.
async function harness(t, seed = async () => {}, { runtimeTtlMs = 60000 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-media-archive-"));
  const codexHome = path.join(root, "codex");
  const workspaceRoot = path.join(root, "workspace");
  const nativeStateFile = path.join(root, "native-state.json");
  const callsFile = path.join(root, "calls.jsonl");
  const favoritesFile = path.join(root, "favorites.json");
  const storeFile = path.join(codexHome, "agent-session-auto-archive.json");
  const fakeCodex = path.join(root, "fake-codex.cjs");
  await Promise.all([mkdir(codexHome), mkdir(workspaceRoot)]);
  await writeFile(nativeStateFile, "{}");
  await writeFile(callsFile, "");
  await writeFile(favoritesFile, "[]");
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
if (!process.argv.includes('app-server')) {
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
  const archived = new Set();
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const state = JSON.parse(fs.readFileSync(process.env.TEST_NATIVE_STATE, 'utf8'));
    const entry = state[message.params?.threadId] || {};
    fs.appendFileSync(process.env.TEST_NATIVE_CALLS, JSON.stringify(message) + '\\n');
    let result = {};
    if (message.method === 'initialize') result = { userAgent: 'fake' };
    if (message.method === 'thread/read') result = { thread: {
      id: message.params.threadId, status: { type: entry.active ? 'active' : 'idle' },
      turns: [{ id: entry.turnId || 'turn-1', status: entry.status || 'completed' }],
    } };
    if (message.method === 'thread/list') result = { data: [], nextCursor: null };
    if (message.method === 'thread/start') result = { thread: { id: process.env.TEST_START_THREAD, turns: [] } };
    if (message.method === 'turn/start') {
      if (archived.has(message.params.threadId)) {
        send({ id: message.id, error: { code: -32000, message: 'thread is archived' } });
        return;
      }
      const turnId = entry.turnId || 'turn-1';
      result = { turn: { id: turnId, status: 'inProgress', items: [] } };
      setTimeout(() => send({ method: 'turn/started', params: {
        threadId: message.params.threadId, turn: { id: turnId, status: 'inProgress' },
      } }), 5);
      setTimeout(() => send({ method: 'turn/completed', params: {
        threadId: message.params.threadId, turn: { id: turnId, status: entry.status || 'completed' },
      } }), 40);
    }
    if (message.method === 'thread/archive' && !entry.failArchive) archived.add(message.params.threadId);
    if (message.method === 'thread/unarchive') archived.delete(message.params.threadId);
    const reply = () => {
      if (message.method === 'thread/archive' && (entry.failArchive || entry.failAfterArchive)) {
        send({ id: message.id, error: { code: -32000, message: 'archive failed' } });
      } else send({ id: message.id, result });
    };
    if (message.method === 'thread/archive' && entry.archiveDelay) setTimeout(reply, entry.archiveDelay);
    else reply();
  });
}
`);
  await chmod(fakeCodex, 0o755);
  const store = new MediaSessionAutoArchiveStore(storeFile, { idleMs });
  const context = { root, codexHome, workspaceRoot, nativeStateFile, callsFile, favoritesFile, store, storeFile };
  await seed(context);
  const authServer = http.createServer((_req, res) => {
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
      CODEX_COMMAND: fakeCodex, CODEX_APP_SERVER_COMMAND: fakeCodex,
      AGENT_HOSTS_FILE: path.join(root, "no-hosts.json"), AGENT_USE_TMUX: "0",
      AGENT_PLATFORM_KERNEL: "legacy", AGENT_NATIVE_THREAD_CATALOG: "0",
      AGENT_MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS: String(idleMs),
      AGENT_MEDIA_SESSION_AUTO_ARCHIVE_CHECK_MS: "30", SESSION_TTL_MS: String(runtimeTtlMs),
      AGENT_SESSION_FAVORITES_FILE: favoritesFile,
      PRIVATE_AUTH_VERIFY_URL: "http://127.0.0.1:" + authPort,
      TEST_NATIVE_STATE: nativeStateFile, TEST_NATIVE_CALLS: callsFile,
      TEST_START_THREAD: ids[6],
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    const exited = new Promise((resolve) => child.once("exit", resolve));
    if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    await new Promise((resolve) => authServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"));
  return {
    ...context,
    output: () => output,
    archives: () => jsonFile(path.join(codexHome, "session-archive.json"), {}),
    calls: async () => (await readFile(callsFile, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
    state: (state) => writeFile(nativeStateFile, JSON.stringify(state)),
    async connect(transport = "terminal") {
      const client = await connect("ws://127.0.0.1:" + agentPort + "/terminal?cwd=.&transport=" + transport + "&access=safe");
      sockets.push(client.ws);
      const status = await client.next((message) => message.type === "status");
      await client.next((message) => message.type === "replay");
      return { ...client, id: status.payload.id };
    },
    async complete(client, sessionId, turnId) {
      const response = await fetch("http://127.0.0.1:" + agentPort + "/internal/codex-notify", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ webSessionId: client.id, event: {
          type: "agent-turn-complete", "thread-id": sessionId, "turn-id": turnId,
          "last-assistant-message": "Extraction finished.",
        } }),
      });
      assert.equal(response.status, 200, output);
    },
  };
}

function track(store, sessionId, { completed = Date.now() - 5000, turnId = "turn-1" } = {}) {
  store.recordPrompt({ hostId: "personal", sessionId, text: "https://v.douyin.com/demo/",
    isFirstPrompt: true, now: completed - 100 });
  store.recordCompletion({ hostId: "personal", sessionId, turnId, now: completed });
}

async function submit(client, text) {
  client.ws.send(JSON.stringify({ type: "submit", data: text }));
  await client.next((message) => message.type === "control-ack" && message.payload.kind === "submit");
}

test("restart recovery archives expired media threads and protects favorites, active turns and RPC failures", async (t) => {
  const h = await harness(t, async ({ store, nativeStateFile, favoritesFile }) => {
    for (const id of ids.slice(0, 5)) track(store, id);
    await writeFile(favoritesFile, JSON.stringify([ids[1]]));
    await writeFile(nativeStateFile, JSON.stringify({
      [ids[2]]: { active: true, status: "inProgress" },
      [ids[3]]: { turnId: "newer-external-turn" },
      [ids[4]]: { failArchive: true },
    }));
  });
  await waitFor(async () => (await h.archives())[ids[0]]);
  await delay(150);
  const archive = await h.archives();
  assert.deepEqual(Object.keys(archive), [ids[0]], h.output());
  const calls = await h.calls();
  assert.equal(calls.some((call) => call.method === "thread/archive" && call.params.threadId === ids[1]), false);
  assert.equal(calls.some((call) => call.method === "thread/archive" && call.params.threadId === ids[2]), false);
  assert.equal(calls.some((call) => call.method === "thread/archive" && call.params.threadId === ids[3]), false);
  assert.ok(calls.some((call) => call.method === "thread/archive" && call.params.threadId === ids[4]));
  assert.equal(new MediaSessionAutoArchiveStore(h.storeFile).get({ hostId: "personal", sessionId: ids[0] }).completedAt, null);
});

test("a real submitted extraction survives follow-ups and archives only after the latest completion", async (t) => {
  const h = await harness(t);
  const client = await h.connect();
  client.ws.send(JSON.stringify({ type: "input", data: "\u001b[A" }));
  await client.next((message) => message.type === "control-ack" && message.payload.kind === "input");
  await submit(client, "https://xhslink.cn/demo");
  await h.state({ [ids[0]]: { turnId: "turn-1" } });
  await h.complete(client, ids[0], "turn-1");
  await delay(80);
  await submit(client, "再检查一下第三段");
  await delay(idleMs + 100);
  assert.equal((await h.archives())[ids[0]], undefined, h.output());
  await h.state({ [ids[0]]: { turnId: "turn-2" } });
  await h.complete(client, ids[0], "turn-2");
  await delay(100);
  assert.equal((await h.archives())[ids[0]], undefined);
  await h.complete(client, ids[0], "turn-1"); // An old notification must not replace the latest deadline.
  await waitFor(async () => (await h.archives())[ids[0]]);
  const saved = new MediaSessionAutoArchiveStore(h.storeFile).get({ hostId: "personal", sessionId: ids[0] });
  assert.equal(saved.kind, "xiaohongshu");
  assert.equal(saved.lastCompletedTurnId, "turn-2");
});

test("a new prompt during the native archive RPC restores the thread before submitting", async (t) => {
  const h = await harness(t);
  const client = await h.connect();
  await submit(client, "https://v.douyin.com/demo/");
  await h.state({ [ids[0]]: { turnId: "turn-1", archiveDelay: 200 } });
  await h.complete(client, ids[0], "turn-1");
  await waitFor(async () => (await h.calls()).some((call) => call.method === "thread/archive"));
  await submit(client, "还要补充一个时间戳");
  assert.ok((await h.calls()).some((call) => call.method === "thread/unarchive"), h.output());
  assert.equal((await h.archives())[ids[0]], undefined);
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  await delay(idleMs + 100);
  assert.equal((await h.archives())[ids[0]], undefined);
});

test("a failed archive response still restores a thread when a follow-up arrived during the request", async (t) => {
  const h = await harness(t);
  await h.state({ [ids[6]]: { turnId: "turn-1", archiveDelay: 200, failAfterArchive: true } });
  const client = await h.connect("app-server");
  await submit(client, "https://v.douyin.com/demo/");
  await waitFor(async () => (await h.calls()).some((call) => call.method === "thread/archive"));
  await h.state({ [ids[6]]: { turnId: "turn-2" } });
  await submit(client, "补充一句原文");
  const calls = await h.calls();
  const unarchiveIndex = calls.findIndex((call) => call.method === "thread/unarchive");
  const followUpIndex = calls.findLastIndex((call) => call.method === "turn/start");
  assert.ok(unarchiveIndex >= 0 && followUpIndex > unarchiveIndex, h.output());
  assert.equal((await h.archives())[ids[6]], undefined);
  assert.equal(client.ws.readyState, WebSocket.OPEN);
});

test("existing completed extraction histories are classified from their original prompt", async (t) => {
  const h = await harness(t, async ({ codexHome }) => {
    const completedAt = Date.now() - 5000;
    const directory = path.join(codexHome, "sessions", "2026", "10", "04");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "rollout-2026-10-04T01-00-00-" + ids[0] + ".jsonl"), [
      JSON.stringify({ type: "session_meta", payload: { id: ids[0], cwd: ".", timestamp: new Date(completedAt - 1000).toISOString() } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "https://v.douyin.com/old/" } }),
    ].join("\n") + "\n");
    await writeFile(path.join(codexHome, "agent-session-settings.json"), JSON.stringify({
      [ids[0]]: { access: "safe", lastCompletedTurnId: "turn-1", lastCompletedAt: new Date(completedAt).toISOString() },
    }));
    await writeFile(path.join(codexHome, "session-titles.json"), JSON.stringify({ [ids[0]]: "Renamed session" }));
  });
  await waitFor(async () => (await h.archives())[ids[0]]);
  assert.equal(new MediaSessionAutoArchiveStore(h.storeFile).get({ hostId: "personal", sessionId: ids[0] }).kind, "douyin");
});

test("App Server failures remain available and a successful follow-up starts the deadline", async (t) => {
  const h = await harness(t);
  await h.state({ [ids[6]]: { turnId: "failed-turn", status: "failed" } });
  const client = await h.connect("app-server");
  await submit(client, "https://v.douyin.com/demo/");
  await client.next((message) => message.type === "status" &&
    message.payload.turnState?.lastCompletedTurnId === "failed-turn" && !message.payload.turnState.active);
  await delay(idleMs + 100);
  assert.equal((await h.archives())[ids[6]], undefined, h.output());
  assert.equal(new MediaSessionAutoArchiveStore(h.storeFile).get({ hostId: "personal", sessionId: ids[6] }).completedAt, null);
  await h.state({ [ids[6]]: { turnId: "successful-turn" } });
  await submit(client, "重试提取");
  await waitFor(async () => (await h.archives())[ids[6]]);
});

test("App Server runtime reclamation does not discard an extraction's archive deadline", async (t) => {
  const h = await harness(t, async ({ nativeStateFile }) => {
    await writeFile(nativeStateFile, JSON.stringify({ [ids[6]]: { turnId: "turn-1" } }));
  }, { runtimeTtlMs: 150 });
  const client = await h.connect("app-server");
  await submit(client, "https://xhslink.cn/demo");
  await client.next((message) => message.type === "status" && message.payload.released);
  assert.equal((await h.archives())[ids[6]], undefined);
  await waitFor(async () => (await h.archives())[ids[6]]);
});

async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

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
    } else queue.push(message);
  });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  return { ws, next(predicate) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, 3000);
      waiters.push(waiter);
    });
  } };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for condition");
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
