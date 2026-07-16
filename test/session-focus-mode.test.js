import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("session focus mode keeps views and page controls while hiding surrounding controls", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/session-focus-mode.js", import.meta.url), "utf8"),
    readFile(new URL("../public/session-focus-mode.css", import.meta.url), "utf8"),
  ]);

  assert.match(html, /session-focus-mode\.css\?v=20260716-1/);
  assert.match(html, /session-focus-mode\.js\?v=20260716-1/);
  assert.match(script, /viewTabs\.append\(toggle\)/);
  assert.match(script, /sessionScreen\.classList\.toggle\("session-focus-mode", active\)/);
  assert.match(script, /event\.touches\.length > 1/);
  assert.match(script, /window\.dispatchEvent\(new Event\("resize"\)\)/);
  assert.match(styles, /session-focus-mode \.session-header,[\s\S]*session-focus-mode \.composer[\s\S]*display: none/);
  assert.match(styles, /session-focus-mode \.quick-actions/);
  assert.match(styles, /touch-action: pan-y pinch-zoom/);
  assert.match(styles, /session-focus-mode \.view-tabs \{\s*padding-top:/);
});
