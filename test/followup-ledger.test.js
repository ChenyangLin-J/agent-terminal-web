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
  assert.match(app, /sendPromptButton\.textContent = latestTurnState\.active \? "追加当前" : "新任务"/);
  assert.match(page, /id="turn-ledger"/);
  assert.match(page, /id="queue-prompt"/);
});

test("App Server is optional and binds steer and queue to structured turns", () => {
  assert.match(page, /<option value="terminal">Terminal（稳定）<\/option>/);
  assert.match(page, /<option value="app-server">App Server（试用）<\/option>/);
  assert.match(server, /appServer\.steerTurn\(steerPromptText\(text/);
  assert.match(server, /appServer\.queueTurn\(queuePromptText\(text/);
  assert.match(appServerClient, /const expectedTurnId = this\.activeTurnId/);
  assert.match(appServerClient, /expectedTurnId,/);
  assert.match(app, /activeTransport === "app-server"/);
  assert.match(app, /"queue-fallback": "当前任务刚刚结束，已自动转到下一轮。"/);
  assert.match(page, /id="agent-request"/);
});
