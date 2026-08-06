import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  CodexAppServerClient,
  CodexAppServerConnection,
  DEFAULT_APP_SERVER_ARGS,
} from "../lib/codex-app-server-client.js";

test("app-server clients enable realtime conversations by default", () => {
  assert.deepEqual(DEFAULT_APP_SERVER_ARGS, ["app-server", "--enable", "realtime_conversation"]);
});

test("app-server client steers the exact active turn and starts queued work after completion", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  assert.equal(client.serverInfo.userAgent, "fake");
  const thread = await client.startThread({ cwd: "/tmp" });
  assert.equal(thread.id, "thread-1");

  const turn = await client.startTurn("Original request");
  assert.equal(turn.id, "turn-1");

  await client.steerTurn("Follow-up that supplements the original request");
  const steer = fake.received.find((message) => message.method === "turn/steer");
  assert.deepEqual(steer.params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "Follow-up that supplements the original request" }],
  });

  let queuedStarted = false;
  const queued = client.queueTurn("Next turn").then(() => {
    queuedStarted = true;
  });
  await tick();
  assert.equal(queuedStarted, false);
  assert.equal(fake.received.filter((message) => message.method === "turn/start").length, 1);

  fake.send({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1" } } });
  await queued;
  assert.equal(queuedStarted, true);
  const starts = fake.received.filter((message) => message.method === "turn/start");
  assert.equal(starts.length, 2);
  assert.deepEqual(starts[1].params.input, [{ type: "text", text: "Next turn" }]);
});

test("app-server client rejects a steer when there is no active turn", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  await assert.rejects(() => client.steerTurn("Too late"), /no active turn/i);
});

test("app-server client interrupts only the active turn", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  await client.startTurn("Long-running request");
  await client.interruptTurn();

  const interrupt = fake.received.find((message) => message.method === "turn/interrupt");
  assert.deepEqual(interrupt.params, { threadId: "thread-1", turnId: "turn-1" });
});

test("app-server client resumes with its initial paginated turn page", async (t) => {
  const fake = createFakeAppServer({ resumedTurnStatus: "inProgress" });
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  const result = await client.resumeThreadWithResult("thread-large", {
    excludeTurns: true,
    initialTurnsPage: { limit: 3, sortDirection: "desc", itemsView: "full" },
  });

  const resume = fake.received.find((message) => message.method === "thread/resume");
  assert.deepEqual(resume.params, {
    threadId: "thread-large",
    excludeTurns: true,
    initialTurnsPage: { limit: 3, sortDirection: "desc", itemsView: "full" },
  });
  assert.equal(result.initialTurnsPage.data.length, 1);
  assert.equal(client.activeTurnId, "recent-turn");
  assert.equal(fake.received.some((message) => message.method === "thread/turns/list"), false);
});

test("a resumed turn that completes with the resume response is not left active", async (t) => {
  const fake = createFakeAppServer({
    resumedTurnStatus: "inProgress",
    completeResumedTurnImmediately: true,
  });
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.resumeThreadWithResult("thread-large", {
    initialTurnsPage: { limit: 3, sortDirection: "desc", itemsView: "full" },
  });

  assert.equal(client.activeTurnId, "");
});

test("app-server client can read turns for an explicit thread without resuming it", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.listThreadTurns({ threadId: "thread-paused", limit: 40 });

  const request = fake.received.find((message) => message.method === "thread/turns/list");
  assert.deepEqual(request.params, {
    threadId: "thread-paused",
    limit: 40,
    cursor: null,
    sortDirection: "desc",
    itemsView: "full",
  });
  assert.equal(client.threadId, "");
});

test("a turn that completes in the same output chunk is not left active", async (t) => {
  const fake = createFakeAppServer({ completeTurnImmediately: true });
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  const turn = await client.startTurn("Very short request");
  assert.equal(turn.id, "turn-1");
  assert.equal(client.activeTurnId, "");
  await assert.rejects(() => client.steerTurn("Arrived too late"), /no active turn/i);
});

test("app-server client submits structured skills and reads command data", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000, cwd: "/workspace" });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  await client.startTurn(
    [
      { type: "skill", name: "thinking-partner", path: "/skills/thinking-partner/SKILL.md" },
      { type: "text", text: "$thinking-partner 帮我想清楚" },
      { type: "localImage", path: "/workspace/uploads/chart.png" },
      { type: "mention", name: "report.pdf", path: "/workspace/uploads/report.pdf" },
    ],
    {
      sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/workspace"], networkAccess: false },
      approvalPolicy: "on-request",
      additionalContext: {
        "personal-memory": { kind: "application", value: "User-approved memory" },
      },
    },
  );
  const turn = fake.received.find((message) => message.method === "turn/start");
  assert.equal(turn.params.input[0].type, "skill");
  assert.equal(turn.params.input[0].name, "thinking-partner");
  assert.deepEqual(turn.params.input.slice(2), [
    { type: "localImage", path: "/workspace/uploads/chart.png" },
    { type: "mention", name: "report.pdf", path: "/workspace/uploads/report.pdf" },
  ]);
  assert.deepEqual(turn.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: ["/workspace"],
    networkAccess: false,
  });
  assert.deepEqual(turn.params.additionalContext, {
    "personal-memory": { kind: "application", value: "User-approved memory" },
  });

  const [skills, config, rateLimits, thread, account, usage, models, mcp, plugins, hooks] = await Promise.all([
    client.listSkills(),
    client.readConfig(),
    client.readRateLimits(),
    client.readThread(),
    client.readAccount(),
    client.readAccountUsage(),
    client.listModels(),
    client.listMcpServers(),
    client.listPlugins(),
    client.listHooks(),
  ]);
  assert.equal(skills.data[0].skills[0].name, "thinking-partner");
  assert.equal(config.config.model, "gpt-test");
  assert.equal(rateLimits.rateLimits.primary.usedPercent, 12);
  assert.equal(thread.id, "thread-1");
  assert.equal(account.account.email, "test@example.com");
  assert.equal(usage.summary.currentStreakDays, 3);
  assert.equal(models.data[0].id, "gpt-test");
  assert.equal(mcp.data[0].name, "docs");
  assert.equal(plugins.marketplaces[0].plugins[0].name, "test-plugin");
  assert.equal(hooks.data[0].hooks.length, 0);

  await client.setThreadName("Renamed");
  await client.setThreadArchived(true);
  await client.setThreadArchived(false);
  await client.compactThread();
  await client.setThreadGoal("Ship it");
  const goal = await client.readThreadGoal();
  assert.equal(goal.goal.objective, "Ship it");
  await client.clearThreadGoal();
  assert.ok(fake.received.some((message) => message.method === "thread/name/set"));
  assert.deepEqual(
    fake.received
      .filter((message) => ["thread/archive", "thread/unarchive"].includes(message.method))
      .map((message) => message.params),
    [{ threadId: "thread-1" }, { threadId: "thread-1" }],
  );
  assert.ok(fake.received.some((message) => message.method === "thread/compact/start"));
});

test("app-server client exposes native search, fork, and subagent thread listing", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  const [threads, search, occurrences] = await Promise.all([
    client.listThreads({ ancestorThreadId: "thread-1" }),
    client.searchThreads("history", { archived: false }),
    client.searchThreadOccurrences("needle"),
  ]);
  const forked = await client.forkThread({ lastTurnId: "turn-1", excludeTurns: true });

  assert.equal(threads.data[0].id, "child-thread");
  assert.equal(search.data[0].thread.id, "thread-search");
  assert.equal(occurrences.data[0].itemId, "item-match");
  assert.equal(forked.thread.id, "thread-fork");
  assert.equal(client.threadId, "thread-fork");
  assert.ok(fake.received.some((message) => message.method === "thread/fork"));
});

test("app-server client exposes Realtime V3 and targeted Agent interruption", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  const voices = await client.listRealtimeVoices();
  await client.startRealtime({
    version: "v3",
    voice: "marin",
    outputModality: "audio",
    transport: { type: "websocket" },
  });
  await client.appendRealtimeAudio({
    data: "AAA=",
    sampleRate: 24_000,
    numChannels: 1,
    samplesPerChannel: 1,
    itemId: null,
  });
  await client.appendRealtimeText("补充说明");
  await client.stopRealtime();
  await client.interruptThreadTurn("child-thread", "child-turn");

  assert.deepEqual(voices.voices.v2, ["marin", "cedar"]);
  assert.deepEqual(
    fake.received.find((message) => message.method === "thread/realtime/start").params,
    {
      threadId: "thread-1",
      version: "v3",
      voice: "marin",
      outputModality: "audio",
      transport: { type: "websocket" },
    },
  );
  assert.deepEqual(
    fake.received.find((message) => message.method === "thread/realtime/appendText").params,
    { threadId: "thread-1", text: "补充说明", role: "user" },
  );
  assert.ok(
    fake.received.some(
      (message) =>
        message.method === "turn/interrupt" &&
        message.params.threadId === "child-thread" &&
        message.params.turnId === "child-turn",
    ),
  );
});

test("subagent turn notifications do not replace the main thread active turn", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  await client.startTurn("Main task");
  assert.equal(client.activeTurnId, "turn-1");

  fake.send({ method: "turn/started", params: { threadId: "child-thread", turn: { id: "child-turn" } } });
  fake.send({ method: "turn/completed", params: { threadId: "child-thread", turn: { id: "child-turn" } } });
  await tick();

  assert.equal(client.activeTurnId, "turn-1");
});

test("app-server error notifications do not crash clients without error listeners", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.startThread();
  const notifications = [];
  client.on("notification", (message) => notifications.push(message));

  const errorNotification = {
    method: "error",
    params: {
      error: { message: "Reconnecting... 2/5" },
      willRetry: true,
      threadId: "thread-1",
      turnId: "turn-1",
    },
  };
  fake.send(errorNotification);
  await tick();

  assert.deepEqual(notifications, [errorNotification]);
  assert.equal(client.closed, false);
});

test("one app-server connection isolates concurrent threads and survives a client detach", async (t) => {
  const fake = createFakeAppServer();
  let spawnCount = 0;
  const connection = new CodexAppServerConnection({
    spawnImpl: () => {
      spawnCount += 1;
      return fake.child;
    },
    requestTimeoutMs: 1_000,
  });
  const first = new CodexAppServerClient({ connection, cwd: "/workspace/first" });
  const second = new CodexAppServerClient({ connection, cwd: "/workspace/second" });
  t.after(() => connection.close());

  await Promise.all([first.start(), second.start()]);
  assert.equal(spawnCount, 1);
  assert.equal(fake.received.filter((message) => message.method === "initialize").length, 1);

  await first.startThread({ cwd: first.cwd });
  await second.resumeThread("thread-2", { cwd: second.cwd });
  const [firstTurn, secondTurn] = await Promise.all([
    first.startTurn("First thread"),
    second.startTurn("Second thread"),
  ]);
  assert.equal(firstTurn.id, "turn-1");
  assert.equal(secondTurn.id, "turn-2");
  assert.deepEqual(
    fake.received
      .filter((message) => message.method === "turn/start")
      .map((message) => message.params.threadId),
    ["thread-1", "thread-2"],
  );

  const firstNotifications = [];
  const secondNotifications = [];
  const firstRequests = [];
  const secondRequests = [];
  first.on("notification", (message) => firstNotifications.push(message));
  second.on("notification", (message) => secondNotifications.push(message));
  first.on("server-request", (message) => firstRequests.push(message));
  second.on("server-request", (message) => secondRequests.push(message));

  fake.send({ method: "turn/completed", params: { threadId: "thread-2", turn: { id: "turn-2" } } });
  fake.send({
    id: 900,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread-2", turnId: "turn-2", itemId: "item-2" },
  });
  await tick();

  assert.equal(first.activeTurnId, "turn-1");
  assert.equal(second.activeTurnId, "");
  assert.equal(firstNotifications.length, 0);
  assert.equal(secondNotifications.length, 1);
  assert.equal(firstRequests.length, 0);
  assert.equal(secondRequests.length, 1);

  await second.unsubscribeThread();
  assert.equal(second.threadId, "");
  assert.ok(
    fake.received.some(
      (message) => message.method === "thread/unsubscribe" && message.params.threadId === "thread-2",
    ),
  );
  second.close();
  assert.equal(fake.killCount, 0);
  assert.equal((await first.readThread()).id, "thread-1");
});

test("a shared initialization failure closes every attached thread client", async () => {
  const fake = createFakeAppServer({ initializeError: true });
  const connection = new CodexAppServerConnection({
    spawnImpl: () => fake.child,
    requestTimeoutMs: 1_000,
  });
  const first = new CodexAppServerClient({ connection });
  const second = new CodexAppServerClient({ connection });

  await assert.rejects(
    Promise.all([first.start(), second.start()]),
    /initialization rejected/i,
  );
  assert.equal(connection.closed, true);
  assert.equal(first.closed, true);
  assert.equal(second.closed, true);
  assert.equal(fake.killCount, 1);
});

function createFakeAppServer({
  completeResumedTurnImmediately = false,
  completeTurnImmediately = false,
  initializeError = false,
  resumedTurnStatus = "",
} = {}) {
  const child = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const received = [];
  let inputBuffer = "";
  let turnNumber = 0;
  let killCount = 0;

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
      killCount += 1;
      stdin.end();
      stdout.end();
      stderr.end();
    },
  });

  function handle(message) {
    if (message.method === "initialize") {
      if (initializeError) {
        send({ id: message.id, error: { message: "Initialization rejected" } });
      } else {
        send({ id: message.id, result: { userAgent: "fake" } });
      }
      return;
    }
    if (message.method === "thread/start") {
      send({ id: message.id, result: { thread: { id: "thread-1" } } });
      return;
    }
    if (message.method === "thread/resume") {
      const response = {
        id: message.id,
        result: {
          thread: { id: message.params.threadId, turns: [] },
          initialTurnsPage: {
            data: [{ id: "recent-turn", status: resumedTurnStatus, items: [] }],
            nextCursor: "older",
          },
        },
      };
      if (completeResumedTurnImmediately) {
        sendTogether([
          response,
          {
            method: "turn/completed",
            params: { threadId: message.params.threadId, turn: { id: "recent-turn" } },
          },
        ]);
      } else {
        send(response);
      }
      return;
    }
    if (message.method === "thread/fork") {
      send({ id: message.id, result: { thread: { id: "thread-fork", turns: [] } } });
      return;
    }
    if (message.method === "thread/list") {
      send({ id: message.id, result: { data: [{ id: "child-thread" }], nextCursor: null } });
      return;
    }
    if (message.method === "thread/search") {
      send({
        id: message.id,
        result: { data: [{ thread: { id: "thread-search" }, snippet: "history" }], nextCursor: null },
      });
      return;
    }
    if (message.method === "thread/searchOccurrences") {
      send({
        id: message.id,
        result: {
          data: [
            {
              turnId: "turn-match",
              itemId: "item-match",
              snippet: "needle",
              snippetMatchRange: { start: 0, end: 6 },
              turnCursor: "cursor-match",
            },
          ],
          nextCursor: null,
        },
      });
      return;
    }
    if (message.method === "thread/turns/list") {
      send({ id: message.id, result: { data: [{ id: "recent-turn", items: [] }], nextCursor: "older" } });
      return;
    }
    if (message.method === "thread/read") {
      send({ id: message.id, result: { thread: { id: message.params.threadId, cliVersion: "0.test" } } });
      return;
    }
    if (message.method === "skills/list") {
      send({
        id: message.id,
        result: {
          data: [
            {
              cwd: "/workspace",
              skills: [
                {
                  name: "thinking-partner",
                  description: "Think clearly",
                  path: "/skills/thinking-partner/SKILL.md",
                  enabled: true,
                },
              ],
            },
          ],
        },
      });
      return;
    }
    if (message.method === "config/read") {
      send({ id: message.id, result: { config: { model: "gpt-test" }, origins: {} } });
      return;
    }
    if (message.method === "account/rateLimits/read") {
      send({ id: message.id, result: { rateLimits: { primary: { usedPercent: 12 } } } });
      return;
    }
    if (message.method === "account/read") {
      send({ id: message.id, result: { account: { type: "chatgpt", email: "test@example.com", planType: "plus" } } });
      return;
    }
    if (message.method === "account/usage/read") {
      send({ id: message.id, result: { summary: { currentStreakDays: 3 }, dailyUsageBuckets: [] } });
      return;
    }
    if (message.method === "model/list") {
      send({ id: message.id, result: { data: [{ id: "gpt-test" }], nextCursor: null } });
      return;
    }
    if (message.method === "mcpServerStatus/list") {
      send({ id: message.id, result: { data: [{ name: "docs", tools: {} }], nextCursor: null } });
      return;
    }
    if (message.method === "plugin/list") {
      send({ id: message.id, result: { marketplaces: [{ name: "test", plugins: [{ name: "test-plugin" }] }] } });
      return;
    }
    if (message.method === "hooks/list") {
      send({ id: message.id, result: { data: [{ cwd: "/workspace", hooks: [], warnings: [], errors: [] }] } });
      return;
    }
    if (
      message.method === "thread/name/set" ||
      message.method === "thread/archive" ||
      message.method === "thread/unarchive" ||
      message.method === "thread/compact/start" ||
      message.method === "thread/goal/clear" ||
      message.method === "thread/unsubscribe"
    ) {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "thread/goal/set") {
      send({ id: message.id, result: { goal: { objective: message.params.objective } } });
      return;
    }
    if (message.method === "thread/goal/get") {
      send({ id: message.id, result: { goal: { objective: "Ship it" } } });
      return;
    }
    if (message.method === "thread/realtime/listVoices") {
      send({
        id: message.id,
        result: {
          voices: { v1: ["alloy"], v2: ["marin", "cedar"], defaultV1: "alloy", defaultV2: "marin" },
        },
      });
      return;
    }
    if (
      [
        "thread/realtime/start",
        "thread/realtime/appendAudio",
        "thread/realtime/appendText",
        "thread/realtime/stop",
      ].includes(message.method)
    ) {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === "turn/start") {
      turnNumber += 1;
      const turnId = `turn-${turnNumber}`;
      if (completeTurnImmediately) {
        sendTogether([
          { id: message.id, result: { turn: { id: turnId } } },
          { method: "turn/completed", params: { threadId: "thread-1", turn: { id: turnId } } },
        ]);
      } else {
        send({ id: message.id, result: { turn: { id: turnId } } });
      }
      return;
    }
    if (message.method === "turn/steer") {
      send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      return;
    }
    if (message.method === "turn/interrupt") {
      send({ id: message.id, result: {} });
    }
  }

  function send(message) {
    queueMicrotask(() => stdout.write(`${JSON.stringify(message)}\n`));
  }

  function sendTogether(messages) {
    queueMicrotask(() => stdout.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`));
  }

  return {
    child,
    received,
    send,
    get killCount() {
      return killCount;
    },
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
