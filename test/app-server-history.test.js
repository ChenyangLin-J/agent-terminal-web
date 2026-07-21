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

  assert.match(server, /resumeThread\(launch\.sessionId, \{ \.\.\.params, excludeTurns: true \}\)/);
  assert.match(server, /listThreadTurns\(\{ limit: APP_INITIAL_TURN_LIMIT \}\)/);
  assert.match(server, /restoreAppServerTranscript\(session, \{ \.\.\.thread, turns: recentPage\?\.data \|\| \[\] \}, \{ resumed: true \}\)/);
  assert.match(server, /for \(const turn of turns\)[\s\S]*for \(const item of Array\.isArray\(turn\?\.items\)/);
  assert.match(server, /send\(ws, "app-transcript", publicAppTranscript\(session\)\)/);
  assert.match(server, /item\.type === "userMessage"/);
  assert.match(server, /item\.type === "agentMessage"/);
  assert.match(server, /item\.type === "commandExecution"/);

  assert.match(page, /id="app-server-view"/);
  assert.match(app, /terminalTabButton\.textContent = isAppServer \? "对话" : "Terminal"/);
  assert.match(app, /textTabButton\.textContent = isAppServer \? "原始" : "Text"/);
  assert.match(app, /`已加载最近 \$\{restoredAppTurnCount\} 轮`/);
  assert.match(app, /`加载更早 \$\{APP_INITIAL_TURN_LIMIT\} 轮`/);
  assert.match(server, /async function loadEarlierAppServerHistory\(session\)/);
  assert.match(server, /cursor: session\.restoredHistoryCursor/);
  assert.match(server, /prependAppServerTranscript\(session, turns\)/);
  assert.match(app, /fetch\(`\/api\/session-preview\/\$\{encodeURIComponent\(sessionId\)\}`\)/);
  assert.match(server, /extractSessionConversationFromJsonl\(file, \{ limit: APP_INITIAL_TURN_LIMIT \}\)/);
  assert.match(app, /function diskConversationItems\(conversation = \{\}\)/);
  assert.match(app, /`已从磁盘显示最近 \$\{restoredAppTurnCount\} 轮`/);
  assert.match(app, /if \(!allItems\.length && !activeSessionReady\) return;/);
  assert.match(app, /title\.textContent = "上次完成"/);
  assert.match(app, /"startup-queue": "已排队；会话恢复后会自动开始。"/);
  assert.match(server, /pendingStartupPrompts: \[\]/);
  assert.match(server, /capabilities: \{[\s\S]*startupQueue: session\.transport === APP_SERVER_TRANSPORT/);
  assert.match(server, /void drainAppServerStartupPrompts\(session\)/);
  assert.match(server, /kind: "startup-submit"/);
  assert.match(app, /payload\.kind === "startup-submit"/);
  assert.match(
    server,
    /if \(!USE_TMUX_SESSIONS\) \{[\s\S]*transport: APP_SERVER_TRANSPORT,[\s\S]*args: \["app-server"\]/,
  );
  assert.match(app, /appTranscriptItems = allItems\.map\(normalizeClientTranscriptItem\)/);
  assert.match(app, /appServerView\.scrollTop = previousScrollTop \+ \(appServerView\.scrollHeight - previousScrollHeight\)/);
  assert.match(page, /id="terminal-session-preview"/);
  assert.match(app, /function renderTerminalSessionPreview\(\)/);
  assert.match(styles, /\.app-transcript-user/);
  assert.match(styles, /\.app-transcript-assistant/);
  assert.match(styles, /\.app-transcript-command/);
  assert.match(styles, /\.app-server-view[\s\S]*background: #080a0f/);
  assert.match(styles, /\.app-server-transcript[\s\S]*font-family: ui-monospace/);
  assert.match(app, /function createAppProcessGroup\(items\)/);
  assert.match(app, /item\.type === "assistant" && item\.phase !== "final_answer"/);
  assert.match(app, /function appTurnHasFinalAnswer\(turnId\)/);
  assert.match(app, /const autoExpanded = isActive && !openAppProcessGroups\.has\(groupId\)/);
  assert.match(app, /if \(autoExpanded && group\.open\) return/);
  assert.match(app, /latestTurnState\.active && latestTurnState\.turnId === turnId/);
  assert.match(app, /card\.classList\.add\("app-transcript-commentary"\)/);
  assert.match(server, /memoryCitation: normalizeMemoryCitation\(item\.memoryCitation\)/);
  assert.match(server, /memoryCitation: item\.memoryCitation \|\| null/);
  assert.match(app, /参考了 \$\{count\} 条记忆/);
  assert.match(app, /formatMemoryCitation\(item\.memoryCitation\)/);
  assert.match(app, /message\.textContent = isInterruptedTurn \? "未生成最终回复" : appActivityText\(currentItem\)/);
  assert.match(app, /indicator\.append\(document\.createElement\("i"\)/);
  assert.match(page, /id="disconnect"[\s\S]*>离开<\/button>/);
  assert.doesNotMatch(styles, /\.app-server-session #disconnect/);
  assert.doesNotMatch(styles, /\.app-server-session #prompt/);
  assert.doesNotMatch(styles, /\.app-server-session \.composer(?:\s|\{|:)/);
  assert.match(app, /statusEls\.project\.textContent = sessionLabel/);
  assert.match(app, /activeTransport === "app-server" \? "App Server · " : "Terminal · "/);
  assert.match(styles, /\.app-server-session \.view-tabs \{[\s\S]*display: none/);
  assert.match(styles, /\.app-server-session \.turn-ledger \{[\s\S]*display: none !important/);
  assert.match(styles, /@keyframes app-activity-wave/);
  assert.match(styles, /\.app-transcript-commentary/);
});
