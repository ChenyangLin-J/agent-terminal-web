import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server live sessions show their current turn state", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /status: appServerLiveStatus\(session\)/);
  assert.match(app, /session\?\.transport !== "app-server"/);
  assert.match(app, /turnState\?\.interrupted[\s\S]*label: "已中断"/);
  assert.match(app, /ready === false[\s\S]*label: "恢复中"/);
  assert.match(app, /turnState\?\.active[\s\S]*label: "运行中"/);
  assert.match(app, /state: "waiting", label: "等你回复"/);
  assert.match(styles, /\.session-live-status\[data-state="running"\]/);
  assert.match(styles, /\.session-live-status\[data-state="waiting"\]/);
  assert.match(styles, /\.session-live-status\[data-state="interrupted"\]/);
});
