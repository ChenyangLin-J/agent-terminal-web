import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("composer buttons fill the prompt height without reserving a hidden queue row", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /styles\.css\?v=20260716-terminal-ui-2/);
  assert.match(styles, /#prompt \{[\s\S]*height: 100%/);
  assert.match(styles, /grid-template-rows: 42px minmax\(46px, 1fr\)/);
  assert.match(styles, /:has\(#queue-prompt:not\(\.hidden\)\)[\s\S]*repeat\(2, minmax\(38px, 1fr\)\)/);
});
