import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");

const appServerClient = readFileSync(new URL("../lib/codex-app-server-client.js", import.meta.url), "utf8");

test("follow-ups are explicitly tracked as current-turn requirements", () => {
  assert.match(server, /【追加要求 #\$\{number - 1\}｜不替换前面的要求】/);
  assert.match(server, /deliveryMode: submission\.deliveryMode/);

});

test("the frontend is App Server-only and binds steer and queue to structured turns", () => {

  assert.match(server, /appServer\.steerTurn\(input\(steerPromptText\(text/);
  assert.match(server, /\.queueTurn\(input\(queuePromptText\(text/);
  assert.match(appServerClient, /const expectedTurnId = this\.activeTurnId/);
  assert.match(appServerClient, /expectedTurnId,/);

  assert.match(server, /approvalPolicy: session\.access === FULL_ACCESS_MODE \? "never" : "on-request"/);
  assert.match(server, /\{ type: "dangerFullAccess" \}/);
  assert.match(server, /item\.aggregatedOutput/);
  assert.match(server, /method === "turn\/plan\/updated"/);
  assert.match(server, /function appServerToolResultText\(item\)/);

});
