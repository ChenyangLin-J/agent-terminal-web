import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent home exposes an authenticated external restart control", async () => {
  const [page, app, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="restart-agent"/);
  assert.match(page, /id="restart-agent-label">重启/);
  assert.match(page, /id="session-restart-agent"[^>]*>重启<\/button>/);
  assert.match(page, /id="mobile-restart-agent"[^>]*>重启<\/button>/);
  assert.match(app, /AGENT_RESTART_ENDPOINT = "https:\/\/home\.chenyanglin\.com\/api\/system\/agent\/restart"/);
  assert.match(app, /restartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
  assert.match(app, /sessionRestartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
  assert.match(app, /mobileRestartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
  assert.match(app, /function setRestartAgentControls\(disabled, label\)/);
  assert.match(app, /credentials: "include"/);
  assert.match(app, /waitForAgentRestart\(previousInstance\)/);
  assert.match(app, /loadedAgentInstance = await readAgentInstance\(\)/);
  assert.match(app, /void reloadAfterAgentUpgrade\(\)/);
  assert.match(app, /currentInstance !== loadedAgentInstance/);
  assert.match(server, /app\.get\("\/healthz"/);
  assert.match(server, /res\.setHeader\("X-Agent-Instance", agentInstanceId\)/);
});
