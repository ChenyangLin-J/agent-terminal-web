import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, html, styles] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("mobile navigation occupies its own app row instead of an iOS positioned layer", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(
    styles,
    /@media \(max-width: 820px\)[\s\S]*?\.app \{[\s\S]*?grid-template-rows: minmax\(0, 1fr\) auto;[\s\S]*?overflow: hidden;/,
  );
  assert.match(
    styles,
    /\.app-primary-nav \{\s+position: relative;\s+inset: auto;\s+grid-column: 1;\s+grid-row: 2;/,
  );
  assert.match(
    styles,
    /\.start-screen \{[\s\S]*?grid-row: 1;[\s\S]*?height: 100%;[\s\S]*?overflow-y: auto;/,
  );
  assert.match(
    styles,
    /body\.session-active \.session-screen \{[\s\S]*?grid-row: 1;[\s\S]*?height: 100%;/,
  );
});

test("an explicit App Server submission follows new content across viewport changes", () => {
  assert.match(
    app,
    /if \(send\(message\)\) \{[\s\S]*?startAppTranscriptSubmitFollow\(\);[\s\S]*?promptInput\.value = "";/,
  );
  assert.match(app, /window\.visualViewport\?\.addEventListener\("resize", followAppTranscriptAfterViewportChange\)/);
  assert.match(app, /const shouldFollow = appTranscriptSubmitFollowActive \|\| wasAtBottom;/);
  assert.match(app, /appServerView\.addEventListener\("pointerdown", stopAppTranscriptSubmitFollow/);
});
