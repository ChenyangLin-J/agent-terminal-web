import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, html, styles] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("mobile navigation is anchored to the app shell instead of the iOS fixed layer", () => {
  assert.match(html, /viewport-fit=cover/);
  assert.match(styles, /\.app \{\s+position: relative;/);
  assert.match(
    styles,
    /@media \(max-width: 820px\)[\s\S]*?\.app-primary-nav \{\s+position: absolute;[\s\S]*?inset: auto 0 0;/,
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
