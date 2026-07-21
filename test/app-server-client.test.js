import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CodexAppServerClient } from "../lib/codex-app-server-client.js";

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

test("app-server client resumes metadata first and requests only recent turns", async (t) => {
  const fake = createFakeAppServer();
  const client = new CodexAppServerClient({ spawnImpl: () => fake.child, requestTimeoutMs: 1_000 });
  t.after(() => client.close());

  await client.start();
  await client.resumeThread("thread-large", { excludeTurns: true });
  const page = await client.listThreadTurns({ limit: 3 });

  const resume = fake.received.find((message) => message.method === "thread/resume");
  assert.deepEqual(resume.params, { threadId: "thread-large", excludeTurns: true });
  const recent = fake.received.find((message) => message.method === "thread/turns/list");
  assert.deepEqual(recent.params, {
    threadId: "thread-large",
    limit: 3,
    cursor: null,
    sortDirection: "desc",
    itemsView: "full",
  });
  assert.equal(page.data.length, 1);
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
  await client.compactThread();
  await client.setThreadGoal("Ship it");
  const goal = await client.readThreadGoal();
  assert.equal(goal.goal.objective, "Ship it");
  await client.clearThreadGoal();
  assert.ok(fake.received.some((message) => message.method === "thread/name/set"));
  assert.ok(fake.received.some((message) => message.method === "thread/compact/start"));
});

function createFakeAppServer({ completeTurnImmediately = false } = {}) {
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
      send({ id: message.id, result: { thread: { id: message.params.threadId, turns: [] } } });
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
    if (message.method === "thread/name/set" || message.method === "thread/compact/start" || message.method === "thread/goal/clear") {
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

  return { child, received, send };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}
