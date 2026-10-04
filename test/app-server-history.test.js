import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server resume restores structured history without terminal replay", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /resumeAppServerThread\(session, launch, \{/);
  assert.match(server, /initialTurnsPage: \{[\s\S]*limit: APP_INITIAL_TURN_LIMIT/);
  assert.match(server, /const recentPage = resumed\.initialTurnsPage/);
  assert.match(server, /restoreAppServerTranscript\(session, \{ \.\.\.thread, turns: recentPage\?\.data \|\| \[\] \}, \{ resumed: true \}\)/);
  assert.match(server, /restoreResumedActiveTurnState\(session, recentPage\?\.data \|\| \[\]\)/);
  assert.match(
    server,
    /function restoreResumedActiveTurnState\(session, turns\)[\s\S]*session\.appServer\?\.activeTurnId[\s\S]*state\.active = true/,
  );
  assert.match(server, /for \(const turn of turns\)[\s\S]*for \(const item of Array\.isArray\(turn\?\.items\)/);
  assert.match(server, /send\(ws, "app-transcript", publicAppTranscript\(session\)\)/);
  assert.match(server, /item\.type === "userMessage"/);
  assert.match(server, /item\.type === "agentMessage"/);
  assert.match(server, /item\.type === "commandExecution"/);
  assert.match(server, /item\.type === "dynamicToolCall" && appServerToolLeafName\(item\) === "exec"/);
  assert.match(server, /return commandDisplayText\(item\.cmd \|\| item\.command\)/);

  assert.match(page, /id="app-server-view"/);
  assert.doesNotMatch(app, /terminalTabButton|textTabButton|activeTransport|loadTerminalAssets/);
  assert.match(app, /`已加载最近 \$\{restoredAppTurnCount\} 轮`/);
  assert.match(app, /`加载更早 \$\{APP_INITIAL_TURN_LIMIT\} 轮`/);
  assert.match(server, /async function loadEarlierAppServerHistory\(session\)/);
  assert.match(server, /cursor: session\.restoredHistoryCursor/);
  assert.match(server, /prependAppServerTranscript\(session, turns\)/);
  assert.match(
    app,
    /const previewPath = new URL\(`\/api\/session-preview\/\$\{encodeURIComponent\(sessionId\)\}`[\s\S]*fetch\(`\$\{previewPath\.pathname\}\$\{previewPath\.search\}`\)/,
  );
  assert.match(server, /extractSessionConversationFromJsonl\(file, \{[\s\S]*limit: APP_INITIAL_TURN_LIMIT/);
  assert.match(app, /function handleAppTranscriptScroll\(\)[\s\S]*requestEarlierAppHistory\(\)/);
  assert.match(app, /function loadEarlierPreviewHistory\(\)/);
  assert.match(app, /function diskConversationItems\(conversation = \{\}\)/);
  assert.match(app, /`已从磁盘显示最近 \$\{restoredAppTurnCount\} 轮`/);
  assert.match(app, /if \(!allItems\.length && !activeSessionReady\) return;/);
  assert.match(app, /title\.textContent = "上次完成"/);
  assert.match(app, /"startup-queue": "已排队；会话恢复后会自动开始。"/);
  assert.match(server, /pendingStartupPrompts: \[\]/);
  assert.match(server, /capabilities: \{[\s\S]*startupQueue: true/);
  assert.match(server, /void drainAppServerStartupPrompts\(session\)/);
  assert.match(server, /kind: "startup-submit"/);
  assert.match(app, /payload\.kind === "startup-submit"/);
  assert.match(
    server,
    /transport: APP_SERVER_TRANSPORT,[\s\S]*args: \["app-server"\]/,
  );
  assert.doesNotMatch(server, /USE_TMUX_SESSIONS|transport=terminal|node-pty/);
  assert.match(app, /const normalizedItems = allItems\.map\(normalizeClientTranscriptItem\)/);
  assert.match(app, /appTranscriptItems = normalizedItems/);
  assert.doesNotMatch(page, /<script src="\/vendor\/xterm/);
  assert.doesNotMatch(page, /<link rel="stylesheet" href="\/vendor\/xterm-css/);
  assert.match(app, /APP_READING_POSITION_STORE_KEY/);
  assert.match(app, /function captureAppTranscriptAnchor\(\)/);
  assert.match(app, /function restoreAppTranscriptAnchor\(position\)/);
  assert.match(app, /pendingAppReadingRestore/);
  assert.match(app, /id="app-transcript-latest"|appTranscriptLatestButton/);
  assert.doesNotMatch(page, /terminal-session-preview|view-tabs/);
  assert.doesNotMatch(app, /renderTerminalSessionPreview/);
  assert.match(styles, /\.app-transcript-user/);
  assert.match(styles, /\.app-transcript-assistant/);
  assert.match(styles, /\.app-transcript-command/);
  assert.match(styles, /\.app-server-view[\s\S]*background: #080a0f/);
  assert.match(styles, /\.app-server-transcript[\s\S]*font-family: ui-monospace/);
  assert.match(app, /function createAppProcessGroup\(items, groupNumber = 1\)/);
  assert.match(app, /function replaceAppProcessGroup\(itemId\)/);
  assert.match(app, /function appendAppTranscriptItem\(item\)/);
  assert.match(app, /item\.type === "assistant" && !\["final_answer", "async_question", "async_message"\]\.includes\(item\.phase\)/);
  assert.match(app, /function appTurnHasFinalAnswer\(turnId\)/);
  assert.match(
    app,
    /const autoExpanded =\s*isActive && !openAppProcessGroups\.has\(groupId\) && !collapsedAppProcessGroups\.has\(groupId\)/,
  );
  assert.match(app, /if \(autoExpanded && group\.open\) return/);
  assert.match(app, /latestTurnState\.active && latestTurnState\.turnId === turnId/);
  assert.match(app, /card\.classList\.add\("app-transcript-commentary"\)/);
  assert.match(server, /memoryCitation: normalizeMemoryCitation\(item\.memoryCitation\)/);
  assert.match(server, /memoryCitation: mergeMemoryCitations\(/);
  assert.match(
    server,
    /additionalContext: appServerTurnAdditionalContext\(session, personalMemory\.additionalContext\)/,
  );
  assert.match(app, /读取了 \$\{labels\.length\} 个上下文文档/);
  assert.match(app, /memoryCitationDocumentLabels/);
  assert.match(app, /formatMemoryCitation\(item\.memoryCitation\)/);
  assert.match(app, /isStoppedTurn[\s\S]*"已由你终止，Session 仍可继续"/);
  assert.match(app, /indicator\.append\(document\.createElement\("i"\)/);
  assert.match(page, /id="disconnect"[\s\S]*>离开<\/button>/);
  assert.doesNotMatch(styles, /\.app-server-session #disconnect/);
  assert.doesNotMatch(styles, /\.app-server-session #prompt/);
  assert.doesNotMatch(styles, /\.app-server-session \.composer(?:\s|\{|:)/);
  assert.match(app, /statusEls\.project\.textContent = sessionLabel/);
  assert.match(styles, /\.app-server-session \.turn-ledger \{[\s\S]*display: none !important/);
  assert.match(styles, /@keyframes app-activity-wave/);
  assert.match(styles, /\.app-transcript-commentary/);
});
