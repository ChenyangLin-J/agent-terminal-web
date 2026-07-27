import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("composer buttons fill the prompt height without reserving a hidden queue row", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /styles\.css\?v=20260727-session-favorites-lazy-resume-1/);
  assert.match(styles, /grid-template-areas:[\s\S]*"header"[\s\S]*"content"[\s\S]*"composer"/);
  assert.match(styles, /\.app-server-view \{[\s\S]*grid-area: content/);
  assert.match(styles, /\.composer \{[\s\S]*grid-area: composer/);
  assert.match(styles, /#prompt \{[\s\S]*height: 100%/);
  assert.match(styles, /\.prompt-field \{[\s\S]*height: 96px/);
  assert.match(styles, /grid-template-rows: 42px minmax\(46px, 1fr\)/);
  assert.match(styles, /\.composer-actions:has\(#queue-prompt:not\(\.hidden\)\)[\s\S]*repeat\(2, minmax\(38px, 1fr\)\)[\s\S]*height: 134px/);
  assert.match(styles, /\.composer:has\(#queue-prompt:not\(\.hidden\)\) \.prompt-field \{[\s\S]*height: 134px/);
  assert.doesNotMatch(styles, /\.app-server-session \.composer(?:\s|\{|:)/);
});
