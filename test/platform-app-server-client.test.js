import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { CodexAppServerConnection } from "../lib/codex-app-server-client.js";
import {
  PlatformAppServerClient,
  jsonFileBindingStore,
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
  assert.equal("io" in client, false, "the adapter must not create a second legacy client state machine");
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

test("platform client reads active Turn state from the public kernel description", async (t) => {
  const { fake, client, kernel } = createClient({ sessionId: "project-free" });
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread();

  const review = await client.startReview();
  assert.equal(review.turn.id, "turn-review");
  assert.equal(client.activeTurnId, "turn-review");
  assert.equal(kernel.describeRuntime("project-free").activeTurnId, "turn-review");

  fake.send({
    method: "turn/completed",
    params: { threadId: client.threadId, turn: { id: "turn-review", status: "completed" } },
  });
  await tick();
  assert.equal(client.activeTurnId, "");
});

test('kernel release is projected once and cannot leave an orphan Turn on a closed facade', async (t) => {
  const { client, kernel } = createClient();
  t.after(() => { client.close(); kernel.close(); });
  await client.start();
  await client.startThread();
  assert.equal(client.managesRuntimeLease, true);
  assert.equal(client.runtimeLeaseExpiresAt, kernel.describeRuntime('web-1').runtimeLeaseExpiresAt);
  const releases = [];
  client.on('runtime-released', (payload) => { releases.push(payload); client.close(); });
  const release = kernel.releaseRuntime('web-1', { reason: 'idle-ttl' });
  const concurrentTurn = client.startTurn('too late');
  await assert.rejects(concurrentTurn, /client is closed/);
  await release;
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reason, 'idle-ttl');
  assert.equal(kernel.describeRuntime('web-1').runtimeState, 'released');
});

test('a failed kernel unsubscribe remains observable and cannot fall through to a raw retry', async (t) => {
  const { client, kernel } = createClient();
  t.after(() => { client.close(); kernel.close(); });
  await client.start();
  await client.startThread();
  const request = client.connection.request.bind(client.connection);
  let unsubscribeCount = 0;
  client.connection.request = async (method, params) => {
    if (method === 'thread/unsubscribe') {
      unsubscribeCount += 1;
      throw new Error('unsubscribe failed');
    }
    return request(method, params);
  };
  await assert.rejects(client.request('thread/unsubscribe', { threadId: client.threadId }), /unsubscribe failed/);
  assert.equal(unsubscribeCount, 1);
  assert.equal(kernel.describeRuntime('web-1').runtimeState, 'live');
});

test("platform client preserves raw fork adoption while later Turns resume through the kernel", async (t) => {
  const { fake, client, kernel } = createClient({ sessionId: "project-scoped", cwd: "/workspace/project" });
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/workspace/project" });

  const forked = await client.forkThread({ lastTurnId: "turn-before", cwd: "/workspace/project" });
  assert.equal(forked.thread.id, "thread-fork");
  assert.equal(client.threadId, "thread-fork");
  assert.equal(kernel.describeRuntime("project-scoped").runtimeState, "released");

  const turn = await client.startTurn("Continue on the fork");
  assert.equal(turn.id, "turn-1");
  assert.equal(
    fake.received.some(
      (message) => message.method === "thread/resume" && message.params.threadId === "thread-fork",
    ),
    true,
  );
  assert.equal(kernel.describeRuntime("project-scoped").runtimeState, "live");
});

test("runtime binding storage refuses to overwrite malformed JSON", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agent-web-bindings-"));
  const file = path.join(directory, "runtime-bindings.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(file, "{malformed", "utf8");
  const store = jsonFileBindingStore(file);

  await assert.rejects(() => store.save("session-a", { status: "idle" }), /parse failed/);
  assert.equal(await readFile(file, "utf8"), "{malformed");
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

test("platform client preserves product submission correlation on the native user message", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => { client.close(); kernel.close(); });
  await client.start();
  await client.startThread({ cwd: "/tmp" });
  await client.startTurn("Correlated request", {
    clientUserMessageId: "operation-123",
    operationKey: "operation-123",
  });
  const start = fake.received.find((message) => message.method === "turn/start");
  assert.equal(start.params.clientUserMessageId, "operation-123");
  assert.equal(start.params.operationKey, "operation-123");
});

test("platform client delivers error notifications without requiring an error listener", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/tmp" });
  await client.startTurn("Working");

  const notifications = [];
  client.on("notification", (message) => notifications.push(message));
  for (const willRetry of [true, false]) {
    const notification = {
      method: "error",
      params: {
        threadId: client.threadId,
        turnId: client.activeTurnId,
        error: {
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        },
        willRetry,
      },
    };
    assert.doesNotThrow(() => fake.send(notification));
    assert.deepEqual(notifications.at(-1), notification);
  }
  assert.equal(notifications.length, 2);
  assert.equal(client.closed, false);
  assert.equal(client.connection.closed, false);
});

test("platform client also forwards errors to explicit error listeners", async (t) => {
  const { fake, client, kernel } = createClient();
  t.after(() => {
    client.close();
    kernel.close();
  });
  await client.start();
  await client.startThread({ cwd: "/tmp" });

  const notifications = [];
  const errors = [];
  client.on("notification", (message) => notifications.push(message));
  client.on("error", (params) => errors.push(params));
  const notification = {
    method: "error",
    params: { threadId: client.threadId, error: { message: "Model unavailable" }, willRetry: false },
  };
  fake.send(notification);
  assert.deepEqual(notifications, [notification]);
  assert.deepEqual(errors, [notification.params]);
});

test("a platform turn failure leaves other sessions on the shared connection running", async (t) => {
  const { fake, client, kernel } = createClient();
  const other = new PlatformAppServerClient({
    sessionId: "web-2",
    cwd: "/tmp",
    connection: client.connection,
    kernel,
  });
  t.after(() => {
    client.close();
    other.close();
    kernel.close();
  });
  await client.start();
  await other.start();
  await client.startThread({ cwd: "/tmp" });
  await other.startThread({ cwd: "/tmp" });
  const failedTurn = await client.startTurn("First task");
  const otherTurn = await other.startTurn("Other task");

  const notifications = [];
  const otherNotifications = [];
  client.on("notification", (message) => notifications.push(message));
  other.on("notification", (message) => otherNotifications.push(message));
  const error = {
    message: "Selected model is at capacity. Please try a different model.",
    codexErrorInfo: "serverOverloaded",
  };
  assert.doesNotThrow(() => fake.send({
    method: "error",
    params: { threadId: client.threadId, turnId: failedTurn.id, error, willRetry: false },
  }));
  fake.send({
    method: "turn/completed",
    params: { threadId: client.threadId, turn: { id: failedTurn.id, status: "failed", error } },
  });
  await tick();
  assert.equal(client.activeTurnId, "");
  assert.equal(other.activeTurnId, otherTurn.id);
  assert.deepEqual(otherNotifications, []);
  assert.equal(client.connection.closed, false);
  assert.equal(other.closed, false);

  const delta = {
    method: "item/agentMessage/delta",
    params: { threadId: other.threadId, turnId: otherTurn.id, itemId: "item-2", delta: "Still working" },
  };
  fake.send(delta);
  fake.send({
    method: "turn/completed",
    params: { threadId: other.threadId, turn: { id: otherTurn.id, status: "completed" } },
  });
  await tick();
  assert.deepEqual(otherNotifications[0], delta);
  assert.equal(other.activeTurnId, "");
  assert.equal(notifications.length, 2);
  assert.equal((await client.startTurn("Retry the first task")).id, "turn-3");
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

test("kernel state does not revive a completed Turn when its start response arrives late", async (t) => {
  const fake = createFakeAppServer();
  fake.completeBeforeTurnStartResponse = true;
  const { client, kernel } = createClient({ fake });
  t.after(() => { client.close(); kernel.close(); });
  await client.start();
  await client.startThread({ cwd: "/tmp" });

  const turn = await client.startTurn("Very fast task");
  assert.equal(turn.id, "turn-1");
  assert.equal(client.describeRuntime().activeTurnId, null);
  assert.equal(client.activeTurnId, "");

  const next = await client.startTurn("Next task");
  assert.equal(next.id, "turn-2");
  assert.equal(client.activeTurnId, "turn-2");
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
  const fake = { child, stdout: null, stderr: null, received: null, send: null, completeBeforeTurnStartResponse: false };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received = [];
  let inputBuffer = "";
  let threadNumber = 0;
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
      threadNumber += 1;
      send({ id: message.id, result: { thread: { id: `thread-${threadNumber}` } } });
      return;
    }
    if (message.method === "thread/resume") {
      const activeTurns = message.params.threadId === "thread-large"
        ? [{ id: "recent-turn", status: "inProgress", items: [] }]
        : [];
      send({
        id: message.id,
        result: {
          thread: { id: message.params.threadId, turns: [] },
          initialTurnsPage: {
            data: activeTurns,
            nextCursor: "older",
          },
        },
      });
      return;
    }
    if (message.method === "turn/start") {
      turnNumber += 1;
      if (fake.completeBeforeTurnStartResponse) {
        fake.completeBeforeTurnStartResponse = false;
        const turn = { id: `turn-${turnNumber}`, status: "completed" };
        send({ method: "turn/started", params: { threadId: message.params.threadId, turn } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn } });
        send({ id: message.id, result: { turn } });
        return;
      }
      send({ id: message.id, result: { turn: { id: `turn-${turnNumber}` } } });
      return;
    }
    if (message.method === "review/start") {
      send({ id: message.id, result: { turn: { id: "turn-review" } } });
      return;
    }
    if (message.method === "thread/fork") {
      send({ id: message.id, result: { thread: { id: "thread-fork" } } });
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

  Object.assign(fake, { stdout, stderr, received, send });
  return fake;
}
