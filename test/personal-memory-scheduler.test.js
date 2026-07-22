import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalMemoryScheduler } from "../lib/personal-memory-scheduler.js";

test("completed turns debounce per Session without postponing other Sessions", async () => {
  const timers = [];
  const cleared = [];
  let runs = 0;
  const scheduler = createPersonalMemoryScheduler({
    delayMs: 60_000,
    setTimer(callback, delay) {
      const timer = { callback, delay, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      cleared.push(timer);
    },
    run: async () => { runs += 1; },
  });

  scheduler.schedule("session-a");
  scheduler.schedule("session-b");
  scheduler.schedule("session-a");
  assert.equal(timers.length, 3);
  assert.equal(timers[2].delay, 60_000);
  assert.equal(timers[2].unrefCalled, true);
  assert.deepEqual(cleared, [timers[0]]);

  await timers[1].callback();
  await timers[2].callback();
  assert.equal(runs, 2);
});
