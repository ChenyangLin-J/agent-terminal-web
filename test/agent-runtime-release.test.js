import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntimeReleaseCoordinator } from "../lib/agent-runtime-release.js";
test("same-thread acquisition waits for unsubscribe, other threads remain independent", async () => {
  const coordinator = new AgentRuntimeReleaseCoordinator();
  let finish, entered;
  const calls = [];
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const client = { threadId: "native", activeTurnId: "", closed: false, ownsConnection: false, request: async (method) => {
    calls.push(method);
    await new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  }, close() {
    this.closed = true;
    calls.push("close");
  } };
  const release = coordinator.release(client);
  assert.equal(coordinator.release(client), release);
  let resumed = false;
  const resume = coordinator.waitForThread("native").then(() => {
    resumed = true;
    calls.push("resume");
  });
  await coordinator.waitForThread("other");
  await started;
  assert.equal(resumed, false);
  assert.deepEqual(calls, ["thread/unsubscribe"]);
  finish();
  await release;
  await resume;
  assert.deepEqual(calls, ["thread/unsubscribe", "close", "resume"]);
});
test("interrupt completion precedes unsubscribe and does not close a shared connection", async () => {
  const calls = [];
  const connection = { close() {
    throw new Error("shared connection must stay alive");
  } };
  const client = { threadId: "native", activeTurnId: "turn", ownsConnection: false, connection, request: async (method) => {
    calls.push(method);
    if (method === "turn/interrupt") setTimeout(() => {
      client.activeTurnId = "";
      calls.push("completed");
    }, 1);
  }, close() {
    this.closed = true;
    calls.push("close");
  } };
  await new AgentRuntimeReleaseCoordinator().release(client, { interrupt: true });
  assert.deepEqual(calls, ["turn/interrupt", "completed", "thread/unsubscribe", "close"]);
});
test("release failure reaches a waiting restore, closes the client and leaves no pending barrier", async () => {
  const errors = [];
  const coordinator = new AgentRuntimeReleaseCoordinator({ onError: (value) => errors.push(value) });
  const client = { threadId: "native", activeTurnId: "", ownsConnection: false, request: async () => {
    throw new Error("unsubscribe failed");
  }, close() {
    this.closed = true;
  } };
  const release = coordinator.release(client), restore = coordinator.waitForThread("native");
  await assert.rejects(release, /unsubscribe failed/);
  await assert.rejects(restore, /unsubscribe failed/);
  assert.equal(client.closed, true);
  assert.equal(errors.length, 1);
  await coordinator.waitForThread("native");
});
