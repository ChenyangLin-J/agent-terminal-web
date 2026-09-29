import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CodexAppServerConnection } from "../lib/codex-app-server-client.js";
import {
  PlatformAppServerClient,
  platformKernelFor,
} from "../lib/platform-app-server-client.js";

function memoryBindingStore() {
  const records = new Map();
  return {
    records,
    async load(sessionId) {
      return records.get(String(sessionId)) || null;
    },
    async save(sessionId, patch = {}) {
      const next = { ...(records.get(String(sessionId)) || {}), ...patch };
      records.set(String(sessionId), next);
      return next;
    },
  };
}

function createClient({ fake, sessionId = "web-1", cwd = "/tmp", store = memoryBindingStore() } = {}) {
  fake = fake || createFakeAppServer();
  const connection = new CodexAppServerConnection({
    spawnImpl: () => fake.child,
    requestTimeoutMs: 1_000,
  });
  const kernel = platformKernelFor(connection, {
    bindingStore: store,
    runtimeLeaseMs: 60_000,
    detachedLeaseMs: 60_000,
  });
  const client = new PlatformAppServerClient({ sessionId, cwd, connection, kernel });
  return { fake, client, kernel, store };
}

test("platform client starts a thread through the kernel and keeps extension calls raw", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });

  await client.start();
  const thread = await client.startThread({
    cwd: "/tmp",
    approvalPolicy: "on-request",
    developerInstructions: "product rules",
  });
  assert.equal(thread.id, "thread-1");
  assert.equal(client.threadId, "thread-1");
  const start = fake.received.find((message) => message.method === "thread/start");
  assert.equal(start.params.cwd, "/tmp");
  assert.equal(start.params.developerInstructions, "product rules");

  const config = await client.readConfig({ cwd: "/tmp" });
  assert.equal(config.config.model, "gpt-test");
});

test("platform client steers the exact active turn and surfaces late-steer errors", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/tmp" });
  const turn = await client.startTurn("Original request");
  assert.equal(turn.id, "turn-1");
  assert.equal(client.activeTurnId, "turn-1");

  await client.steerTurn("Follow-up");
  const steer = fake.received.find((message) => message.method === "turn/steer");
  assert.deepEqual(steer.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "Follow-up" }],
  });

  fake.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  await tick();
  await assert.rejects(() => client.steerTurn("Too late"), /no active turn/i);
});

test("platform client queues turns behind the active turn and drains on completion", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/tmp" });
  await client.startTurn("First");
  assert.equal(client.activeTurnId, "turn-1");

  let queuedStarted = false;
  const queued = client.queueTurn("Next turn").then((nextTurn) => {
    queuedStarted = true;
    return nextTurn;
  });
  await tick();
  assert.equal(queuedStarted, false);
  assert.equal(fake.received.filter((message) => message.method === "turn/start").length, 1);

  fake.send({
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  });
  const nextTurn = await queued;
  assert.equal(nextTurn.id, "turn-2");
  const starts = fake.received.filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].params.input, [{ type: "text", text: "Next turn" }]);
});

test("platform client resumes a thread and restores the active turn", async (t) => {
  const { fake, client, kernel } = createClient({ sessionId: "web-resume" });
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  const result = await client.resumeThreadWithResult("thread-large", {
    excludeTurns: true,
    initialTurnsPage: { limit: 3, sortDirection: "desc", itemsView: "full" },
  });
  assert.equal(client.threadId, "thread-large");
  assert.equal(client.activeTurnId, "recent-turn");
  assert.equal(result.initialTurnsPage.data.length, 1);
});

test("platform client surfaces provider requests as server-request events", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/tmp" });
  await client.startTurn("Working");

  const serverRequest = new Promise((resolve) => client.once("server-request", resolve));
  fake.send({
    id: 91,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-1", turnId: "turn-1", command: "rm -rf x" },
  });
  const request = await serverRequest;
  assert.equal(request.method, "item/commandExecution/requestApproval");
  assert.equal(request.params.command, "rm -rf x");
  assert.match(request.id, /^request_/);

  client.respond(request.id, { decision: "accept" });
  await tick();
  const response = fake.received.find((message) => message.id === 91 && message.result);
  assert.deepEqual(response.result, { decision: "accept" });
});

test("platform client releases the runtime through the kernel on unsubscribe", async (t) => {
  const { fake, client, kernel, store } = createClient();
  t.after(() => kernel.close());
  await client.start();
  await client.startThread({ cwd: "/tmp" });

  await client.unsubscribeThread();
  const unsubscribe = fake.received.find((message) => message.method === "thread/unsubscribe");
  assert.equal(unsubscribe.params.threadId, "thread-1");
  assert.equal(client.threadId, "");
  assert.equal(store.records.get("web-1").released, true);
  client.close();
});

test("platform client renews the kernel lease on meaningful activity", async (t) => {
  const { client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  let renewed = 0;
  const original = kernel.renewRuntimeLease.bind(kernel);
  kernel.renewRuntimeLease = (id) => {
    renewed += 1;
    return original(id);
  };
  client.renewRuntimeLease();
  assert.equal(renewed, 1);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeAppServer() {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received = [];
  let inputBuffer = "";
  let turnNumber = 0;

  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      inputBuffer += chunk.toString();
      const lines = inputBuffer.split("\n");
      inputBuffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const message = JSON.parse(line);
        received.push(message);
        handle(message);
      }
      callback();
    },
  });

  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill() {
      stdin.end();
      stdout.end();
      stderr.end();
    },
  });

  function send(message) {
    stdout.write(`${JSON.stringify(message)}\n`);
  }

  function handle(message) {
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake" } });
      return;
    }
    if (message.method === "thread/start") {
      send({ id: message.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (message.method === "thread/resume") {
      send({
        id: message.id,
        result: {
          thread: { id: message.params.threadId, turns: [] },
          initialTurnsPage: {
            data: [{ id: "recent-turn", status: "inProgress", items: [] }],
            nextCursor: "older",
          },
        },
      });
      return;
    }
    if (message.method === "turn/start") {
      turnNumber += 1;
      send({ id: message.id, result: { turn: { id: `turn-${turnNumber}` } } });
      return;
    }
    if (message.method === "turn/steer") {
      send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      return;
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/unsubscribe") {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "config/read") {
      send({ id: message.id, result: { config: { model: "gpt-test" }, origins: {} } });
      return;
    }
    send({ id: message.id, result: {} });
  }

  return { child, stdout, stderr, received, send };
}
