import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile session recovery persists and incrementally restores terminal history", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(source, /localStorage\.setItem\(SESSION_SNAPSHOT_STORE_KEY/);
  assert.match(source, /document\.visibilityState === "hidden"\) \{\s+saveActiveSessionSnapshot\(\)/);
  assert.match(source, /revision: lastOutputRevision/);
  assert.match(source, /query\.set\("afterRevision", String\(lastOutputRevision\)\)/);
  assert.match(source, /payload\.mode === "delta"/);
  assert.match(source, /terminal\?\.refresh\(0, Math\.max\(0, terminal\.rows - 1\)\)/);
  assert.doesNotMatch(source, /terminalView\.classList\.add\("replaying"\)/);
  assert.match(source, /scrollback: 12000/);
  assert.match(page, /app\.js\?v=20260716-notification-route-1/);
});
