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
  assert.match(app, /AGENT_RESTART_ENDPOINT = "https:\/\/home\.chenyanglin\.com\/api\/system\/agent\/restart"/);
  assert.match(app, /restartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
  assert.match(app, /credentials: "include"/);
  assert.match(app, /waitForAgentRestart\(previousInstance\)/);
  assert.match(server, /app\.get\("\/healthz"/);
  assert.match(server, /res\.setHeader\("X-Agent-Instance", agentInstanceId\)/);
});
