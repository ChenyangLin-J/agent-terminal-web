import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile session recovery persists and incrementally restores terminal history", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(source, /localStorage\.setItem\(SESSION_SNAPSHOT_STORE_KEY/);
  assert.match(source, /document\.visibilityState === "hidden"\) \{\s+saveActiveSessionSnapshot\(\)/);
  assert.match(source, /revision: lastOutputRevision/);
  assert.match(source, /query\.set\("afterRevision", String\(lastOutputRevision\)\)/);
  assert.match(source, /payload\.mode === "delta"/);
  assert.match(source, /terminal\?\.refresh\(0, Math\.max\(0, terminal\.rows - 1\)\)/);
  assert.match(source, /const TERMINAL_RECENT_HISTORY_MAX_CHARS = 24_000/);
  assert.match(source, /bufferTerminalHistory\(payload\.raw \|\| ""/);
  assert.match(source, /terminalHistoryChunks\[0\]\.slice\(-TERMINAL_RECENT_HISTORY_MAX_CHARS\)/);
  assert.match(source, /if \(trimmed\) terminalHistoryForceFull = true/);
  assert.match(source, /terminalView\.classList\.add\("replaying"\)/);
  assert.match(source, /\["connected", "loading"\]\.includes\(state\)/);
  assert.match(source, /loading: "已连接 · 恢复最新记录中"/);
  assert.match(source, /function exposeTerminalWhileHistoryIsPending\(\)/);
  assert.match(source, /waitingForDelayedHistory: true/);
  assert.match(source, /terminal-history-late-output/);
  assert.match(source, /const TERMINAL_DELAYED_HISTORY_GUARD_MS = 60_000/);
  assert.match(source, /scrollback: 12000/);
  assert.match(source, /document\.documentElement\.classList\.toggle\("session-active", active\)/);
  assert.match(source, /document\.scrollingElement\.scrollTop = 0/);
  assert.match(styles, /html\.session-active[\s\S]*overflow: hidden/);
  assert.match(styles, /body\.session-active[\s\S]*height: 100dvh/);
  assert.match(page, /app\.js\?v=20260727-process-collapse-1/);
  assert.match(page, /styles\.css\?v=20260727-process-collapse-1/);
});

test("Agent displays dates and starts Codex in Beijing time", async () => {
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(client, /const AGENT_TIME_ZONE = "Asia\/Shanghai"/);
  assert.match(client, /timeZone: AGENT_TIME_ZONE/);
  assert.match(server, /process\.env\.TZ = AGENT_TIME_ZONE/);
  assert.match(server, /timeZone: AGENT_TIME_ZONE/);
});
