import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("URL shortcut starts a new workspace session explicitly", () => {
  assert.match(appSource, /const startNew = params\.get\("new"\) === "1"/);
  assert.match(appSource, /if \(startNew\) \{\s+startSession\(\{\s+\.\.\.launch,\s+mode: "new"/);
  assert.match(appSource, /mode: overrides\.mode \|\| \(sessionId \? "new" : launchModeSelect\.value\)/);
  assert.match(appSource, /const DEFAULT_TRANSPORT = "app-server"/);
  assert.match(appSource, /const DEFAULT_ACCESS_MODE = "full"/);
  assert.match(appSource, /!sessionId \? accessModeSelect\.value \|\| DEFAULT_ACCESS_MODE : ""/);
  assert.match(pageSource, /<option value="app-server" selected>App Server（默认）<\/option>/);
  assert.match(pageSource, /<option value="full" selected>全部允许（默认，高风险）<\/option>/);
  assert.match(pageSource, /app\.js\?v=20260726-inline-rename-1/);
});
