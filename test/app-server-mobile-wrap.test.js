import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server transcript contains long mobile content without clipping", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(styles, /\.app-server-transcript \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*min-width: 0/);
  assert.match(styles, /\.app-transcript-item \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*min-width: 0/);
  assert.match(styles, /\.app-transcript-copy \{[\s\S]*min-width: 0[\s\S]*max-width: 100%/);
  assert.match(styles, /\.app-transcript-markdown table \{[\s\S]*width: 100%/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.app-transcript-markdown pre \{[\s\S]*white-space: pre-wrap/);
  assert.match(styles, /@media \(max-width: 520px\)[\s\S]*\.app-transcript-markdown table \{[\s\S]*table-layout: fixed/);
});
