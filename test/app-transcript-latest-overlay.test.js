import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the new-content prompt overlays the transcript without taking layout space", async () => {
  const [page, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    page,
    /class="app-transcript-latest-layer">\s*<button id="app-transcript-latest"/,
  );
  assert.match(
    styles,
    /\.app-transcript-latest-layer \{[^}]*position: sticky;[^}]*height: 0;[^}]*justify-content: flex-end;[^}]*pointer-events: none;/,
  );
  assert.match(styles, /\.app-transcript-latest \{[^}]*pointer-events: auto;/);
  assert.doesNotMatch(styles, /\.app-transcript-latest \{[^}]*float:/);
});
