import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("expanded execution records keep a visible collapse control", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /const collapsedAppProcessGroups = new Set\(\)/);
  assert.match(
    app,
    /isActive && !openAppProcessGroups\.has\(groupId\) && !collapsedAppProcessGroups\.has\(groupId\)/,
  );
  assert.match(app, /count\.textContent = group\.open \? "收起" : collapsedActionText/);
  assert.match(app, /collapsedAppProcessGroups\.add\(groupId\)/);
  assert.match(app, /collapsedAppProcessGroups\.delete\(groupId\)/);
  assert.match(
    styles,
    /\.app-process-group\[open\] > summary \{[\s\S]*position: sticky;[\s\S]*top: 0;[\s\S]*z-index: 3;/,
  );
});
