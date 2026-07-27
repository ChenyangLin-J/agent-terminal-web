import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("expanded execution records end with a collapse control", async () => {
  const [app, styles] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /const collapsedAppProcessGroups = new Set\(\)/);
  assert.match(
    app,
    /isActive && !openAppProcessGroups\.has\(groupId\) && !collapsedAppProcessGroups\.has\(groupId\)/,
  );
  assert.match(app, /collapse\.className = "app-process-collapse"/);
  assert.match(app, /collapse\.textContent = "收起执行记录"/);
  assert.match(app, /collapse\.addEventListener\("click", \(\) => \{\s*group\.open = false/);
  assert.match(app, /collapsedAppProcessGroups\.add\(groupId\)/);
  assert.match(app, /collapsedAppProcessGroups\.delete\(groupId\)/);
  assert.match(
    styles,
    /\.app-process-collapse \{[^}]*width: calc\(100% - 16px\);[^}]*margin: 8px;/,
  );
  assert.doesNotMatch(styles, /\.app-process-group\[open\] > summary \{[^}]*position: sticky;/);
});
