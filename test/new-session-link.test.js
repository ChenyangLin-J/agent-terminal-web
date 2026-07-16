import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("URL shortcut starts a new workspace session explicitly", () => {
  assert.match(appSource, /const startNew = params\.get\("new"\) === "1"/);
  assert.match(appSource, /if \(startNew\) \{\s+startSession\(\{\s+cwd: params\.get\("cwd"\) \|\| "\."/);
  assert.match(appSource, /mode: overrides\.mode \|\| \(overrides\.sessionId \? "new" : launchModeSelect\.value\)/);
  assert.match(pageSource, /app\.js\?v=20260716-shared-shell-1/);
});
