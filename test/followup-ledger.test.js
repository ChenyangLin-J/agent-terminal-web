import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../server.js", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const page = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

test("follow-ups are explicitly tracked as current-turn requirements", () => {
  assert.match(server, /【追加要求 #\$\{number - 1\}｜不替换前面的要求】/);
  assert.match(server, /deliveryMode: submission\.deliveryMode/);
  assert.match(server, /submitKey: "\\t"/);
  assert.match(app, /已追加到当前任务；不会替换前面的要求。/);
  assert.match(app, /sendPromptButton\.textContent = latestTurnState\.active \? "追加当前" : "新任务"/);
  assert.match(page, /id="turn-ledger"/);
  assert.match(page, /id="queue-prompt"/);
});
