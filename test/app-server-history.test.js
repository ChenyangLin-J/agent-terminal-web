import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server resume restores structured history and keeps raw text available", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /restoreAppServerTranscript\(session, thread, \{ resumed: Boolean\(launch\.sessionId\) \}\)/);
  assert.match(server, /for \(const turn of turns\)[\s\S]*for \(const item of Array\.isArray\(turn\?\.items\)/);
  assert.match(server, /send\(ws, "app-transcript", publicAppTranscript\(session\)\)/);
  assert.match(server, /item\.type === "userMessage"/);
  assert.match(server, /item\.type === "agentMessage"/);
  assert.match(server, /item\.type === "commandExecution"/);

  assert.match(page, /id="app-server-view"/);
  assert.match(app, /terminalTabButton\.textContent = isAppServer \? "对话" : "Terminal"/);
  assert.match(app, /textTabButton\.textContent = isAppServer \? "原始文本" : "Text"/);
  assert.match(app, /`已恢复 \$\{restoredAppTurnCount\} 轮历史`/);
  assert.match(styles, /\.app-transcript-user/);
  assert.match(styles, /\.app-transcript-assistant/);
  assert.match(styles, /\.app-transcript-command/);
});
