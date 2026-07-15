import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("mobile session recovery persists and repaints terminal history", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  assert.match(source, /localStorage\.setItem\(SESSION_SNAPSHOT_STORE_KEY/);
  assert.match(source, /document\.visibilityState === "hidden"\) \{\s+saveActiveSessionSnapshot\(\)/);
  assert.match(source, /isReconnect \? !hasTerminalContent\(\) : true/);
  assert.match(source, /terminal\?\.refresh\(0, Math\.max\(0, terminal\.rows - 1\)\)/);
  assert.doesNotMatch(source, /if \(isReconnect\) return;\s+writeTerminalReplay/);
  assert.match(source, /scrollback: 12000/);
  assert.match(page, /app\.js\?v=20260716-mobile-history-1/);
});
