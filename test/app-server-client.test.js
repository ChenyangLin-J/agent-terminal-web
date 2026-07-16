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
