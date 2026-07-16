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
  assert.match(app, /textTabButton\.textContent = isAppServer \? "原始" : "Text"/);
  assert.match(app, /`已恢复 \$\{restoredAppTurnCount\} 轮历史`/);
  assert.match(styles, /\.app-transcript-user/);
  assert.match(styles, /\.app-transcript-assistant/);
  assert.match(styles, /\.app-transcript-command/);
  assert.match(styles, /\.app-server-view[\s\S]*background: #080a0f/);
  assert.match(styles, /\.app-server-transcript[\s\S]*font-family: ui-monospace/);
  assert.match(app, /function createAppProcessGroup\(items\)/);
  assert.match(app, /\["command", "plan", "file", "tool"\]\.includes\(item\.type\)/);
  assert.match(app, /card\.classList\.add\("app-transcript-commentary"\)/);
  assert.match(app, /message\.textContent = appActivityText\(currentItem\)/);
  assert.match(app, /indicator\.append\(document\.createElement\("i"\)/);
  assert.match(styles, /\.app-server-session #disconnect[\s\S]*display: none/);
  assert.doesNotMatch(styles, /\.app-server-session #prompt/);
  assert.doesNotMatch(styles, /\.app-server-session \.composer(?:\s|\{|:)/);
  assert.match(app, /activeTransport === "app-server" \? sessionLabel : displayProject\(status\.project\)/);
  assert.match(styles, /\.app-server-session \.view-tabs \{[\s\S]*display: none/);
  assert.match(styles, /\.app-server-session \.turn-ledger \{[\s\S]*display: none !important/);
  assert.match(styles, /@keyframes app-activity-wave/);
  assert.match(styles, /\.app-transcript-commentary/);
});
