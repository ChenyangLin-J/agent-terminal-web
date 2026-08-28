import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("URL shortcut opens a new workspace draft without starting a runtime", () => {
  assert.match(appSource, /const startNew = params\.get\("new"\) === "1"/);
  assert.match(appSource, /if \(startNew\) \{\s+openSessionPreview\(\{ \.\.\.launch, mode: "new", preview: "1", new: "1" \}\)/);
  assert.match(appSource, /function openNewSessionDraft\(overrides = \{\}\)/);
  assert.match(appSource, /preview: "1",\s+new: "1"/);
  assert.match(appSource, /detail\.type === "create"\) \{\s*openNewSessionDraft\(\);\s*\}/);
  assert.match(appSource, /function openNewSessionDraft[\s\S]*requestAnimationFrame\(\(\) => promptInput\.focus\(\)\)/);
  assert.match(appSource, /const DEFAULT_TRANSPORT = "app-server"/);
  assert.match(appSource, /const DEFAULT_ACCESS_MODE = "full"/);
  assert.doesNotMatch(pageSource, /id="transport"|id="launch-mode"|id="session-id"/);
  assert.match(pageSource, /<option value="full" selected>全部允许（默认，高风险）<\/option>/);
  assert.match(pageSource, /id="session-host"/);
  assert.match(pageSource, /app\.js\?v=20260828-workspace-canary-1/);
});
