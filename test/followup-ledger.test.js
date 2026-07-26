import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appServerClient = readFileSync(new URL("../lib/codex-app-server-client.js", import.meta.url), "utf8");

test("follow-ups are explicitly tracked as current-turn requirements", () => {
  assert.match(server, /【追加要求 #\$\{number - 1\}｜不替换前面的要求】/);
  assert.match(server, /deliveryMode: submission\.deliveryMode/);
  assert.match(server, /submitKey: "\\t"/);
  assert.match(app, /已追加到当前任务；不会替换前面的要求。/);
  assert.match(app, /pendingEditFork[\s\S]*\? "提交编辑"[\s\S]*latestTurnState\.active[\s\S]*\? "追加当前"[\s\S]*: "新任务"/);
  assert.match(page, /id="turn-ledger"/);
  assert.match(page, /id="queue-prompt"/);
});

test("App Server is the default and binds steer and queue to structured turns", () => {
  assert.match(page, /<option value="terminal">Terminal（完整 CLI）<\/option>/);
  assert.match(page, /<option value="app-server" selected>App Server（默认）<\/option>/);
  assert.match(server, /appServer\.steerTurn\(input\(steerPromptText\(text/);
  assert.match(server, /\.queueTurn\(input\(queuePromptText\(text/);
  assert.match(appServerClient, /const expectedTurnId = this\.activeTurnId/);
  assert.match(appServerClient, /expectedTurnId,/);
  assert.match(app, /activeTransport === "app-server"/);
  assert.match(app, /"queue-fallback": "当前任务刚刚结束，已自动转到下一轮。"/);
  assert.match(page, /id="agent-request"/);
  assert.match(page, /id="resume-engine-dialog"/);
  assert.match(app, /function openResumeEngineDialog\(session\)/);
  assert.match(app, /function resumePendingSession\(transport\)/);
  assert.match(server, /approvalPolicy: session\.access === FULL_ACCESS_MODE \? "never" : "on-request"/);
  assert.match(server, /--dangerously-bypass-approvals-and-sandbox/);
  assert.match(server, /item\.aggregatedOutput/);
  assert.match(server, /method === "turn\/plan\/updated"/);
  assert.match(server, /function appServerToolResultText\(item\)/);
  assert.match(
    app,
    /const shouldShowLedger = items\.length > 0 && \(latestTurnState\.active \|\| latestTurnState\.interrupted \|\| hasFailedItem\)/,
  );
  assert.match(app, /function refreshTerminalText\(\{ follow = false \} = \{\}\)/);
});
