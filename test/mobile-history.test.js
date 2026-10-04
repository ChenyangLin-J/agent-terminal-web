import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile session recovery saves the reading position and probes the connection on return", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(source, /function saveAppReadingPosition\(\)/);
  assert.match(source, /document\.visibilityState === "hidden"\) \{\s+saveAppReadingPosition\(\);/);
  assert.match(source, /ensureVisibleConnection\("visibility-visible", \{ probe: true \}\)/);
  assert.match(source, /function ensureVisibleConnection\(reason, \{ probe = false, replay = true \} = \{\}\)/);
  assert.doesNotMatch(source, /TERMINAL_RECENT_HISTORY_MAX_CHARS|terminalHistoryChunks|bufferTerminalHistory/);
  assert.match(source, /document\.documentElement\.classList\.toggle\("session-active", active\)/);
  assert.match(source, /document\.scrollingElement\.scrollTop = 0/);
  assert.match(styles, /html\.session-active[\s\S]*overflow: hidden/);
  assert.match(styles, /body\.session-active[\s\S]*height: 100dvh/);
  assert.match(page, /app\.js\?v=20260914-auto-memory-1/);
  assert.match(page, /styles\.css\?v=20261004-app-server-1/);
});

test("Agent displays dates and starts Codex in Beijing time", async () => {
  const client = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(client, /const AGENT_TIME_ZONE = "Asia\/Shanghai"/);
  assert.match(client, /timeZone: AGENT_TIME_ZONE/);
  assert.match(server, /process\.env\.TZ = AGENT_TIME_ZONE/);
  assert.match(server, /timeZone: AGENT_TIME_ZONE/);
});
