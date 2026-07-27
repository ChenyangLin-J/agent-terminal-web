import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the control center groups live sessions by real user and turn state", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /section\.className = `control-session-group control-session-group-\$\{group\.kind\}`/);
  assert.match(app, /kind: presentation\.kind/);
  assert.match(app, /kind: "pending", label: "待处理", presentationKinds: \["attention", "unread"\]/);
  assert.match(app, /kind: "ready", label: "空闲", presentationKinds: \["ready", "released"\]/);
  assert.match(app, /pendingServerRequestCount[\s\S]*kind: "attention"[\s\S]*label: "等你处理"/);
  assert.match(app, /turnState\?\.interrupted[\s\S]*kind: "attention"[\s\S]*label: "需要继续"/);
  assert.match(app, /if \(session\?\.released \|\| session\?\.suspended\)/);
  assert.match(app, /hasUnreadResult[\s\S]*kind: "unread"[\s\S]*label: "新结果"/);
  assert.match(app, /session\?\.released \|\| session\?\.suspended[\s\S]*label: "已暂停"/);
  assert.match(app, /ready === false[\s\S]*label: "恢复中"/);
  assert.match(app, /turnState\?\.active \|\| session\?\.turnState\?\.stopping[\s\S]*"停止中" : "运行中"/);
  assert.match(app, /kind: "ready", state: "waiting", label: "空闲"/);
  assert.match(styles, /\.control-session-group-pending > header strong i/);
  assert.match(styles, /\.control-session-group-running > header strong i/);
  assert.match(styles, /\.control-session-group-ready > header strong i/);
  assert.doesNotMatch(styles, /\.session-live-status/);
});
