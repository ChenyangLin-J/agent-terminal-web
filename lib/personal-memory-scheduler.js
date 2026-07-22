export function createPersonalMemoryScheduler(options = {}) {
  const delayMs = Math.max(0, Number(options.delayMs) || 0);
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const run = typeof options.run === "function" ? options.run : async () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const timers = new Map();

  return {
    schedule(key = "default") {
      const timerKey = String(key || "default");
      if (timers.has(timerKey)) clearTimer(timers.get(timerKey));
      const timer = setTimer(async () => {
        timers.delete(timerKey);
        try {
          await run();
        } catch (error) {
          onError(error);
        }
      }, delayMs);
      timer?.unref?.();
      timers.set(timerKey, timer);
    },
    cancel(key = "default") {
      const timerKey = String(key || "default");
      if (timers.has(timerKey)) clearTimer(timers.get(timerKey));
      timers.delete(timerKey);
    },
  };
}
