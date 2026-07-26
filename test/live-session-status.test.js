import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the control center groups live sessions by real user and turn state", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /status: presentation/);
  assert.match(app, /pendingServerRequestCount[\s\S]*kind: "attention"[\s\S]*label: "等你处理"/);
  assert.match(app, /turnState\?\.interrupted[\s\S]*kind: "attention"[\s\S]*label: "需要继续"/);
  assert.match(app, /ready === false[\s\S]*session\?\.released \|\| session\?\.suspended/);
  assert.match(app, /hasUnreadResult[\s\S]*kind: "unread"[\s\S]*label: "新结果"/);
  assert.match(app, /ready === false[\s\S]*label: "恢复中"/);
  assert.match(app, /turnState\?\.active[\s\S]*label: "运行中"/);
  assert.match(app, /kind: "ready", state: "waiting", label: "空闲"/);
  assert.match(styles, /\.session-live-status\[data-state="running"\]/);
  assert.match(styles, /\.session-live-status\[data-state="waiting"\]/);
  assert.match(styles, /\.session-live-status\[data-state="interrupted"\]/);
  assert.match(styles, /\.session-live-status\[data-state="attention"\]/);
  assert.match(styles, /\.session-live-status\[data-state="released"\]/);
  assert.match(styles, /\.session-live-status\[data-state="unread"\]/);
});
