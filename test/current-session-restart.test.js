import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("session restart resumes only the current Codex session", async () => {
  const [server, app, page] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="restart-session"[^>]*title="重启当前 Session"[^>]*>重启<\/button>/);
  assert.match(page, /id="mobile-restart-session"[^>]*>重启<\/button>/);
  assert.match(app, /restartSessionButton\.addEventListener\("click", restartCurrentSession\)/);
  assert.match(app, /mobileRestartSessionButton\.addEventListener\("click", restartCurrentSession\)/);
  assert.match(app, /本轮任务会中断，但历史记录和其他 Session 不受影响/);
  assert.match(app, /fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(webSessionId\)\}\/restart`/);
  assert.match(app, /setConnectedState\("starting"\);\s*setRestartSessionDisabled\(true\)/);
  assert.match(app, /openSocket\(restartParams\)/);
  assert.match(app, /setRestartSessionDisabled\(!activeSessionId \|\| !activeSessionParams\.sessionId \|\| !canManageSession\)/);
  assert.match(server, /app\.post\("\/api\/sessions\/:id\/restart"/);
  assert.match(server, /if \(!session \|\| session\.exited\)/);
  assert.match(server, /session\.ready = false;\s*session\.exited = true;/);
  assert.match(server, /killSessionTerminal\(session\);\s*res\.json\(\{ session: restart \}\)/);

  assert.doesNotMatch(app, /sessionRestartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
  assert.doesNotMatch(app, /mobileRestartAgentButton\.addEventListener\("click", restartAgentWeb\)/);
});
