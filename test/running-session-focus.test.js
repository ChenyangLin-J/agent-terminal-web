import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("opening a running App Server Session follows its latest output", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(
    app,
    /transientDiskPreview =[\s\S]*appTranscriptSource === "disk"[\s\S]*typeof activeSessionPreviewOnly === "undefined"/,
  );
  assert.match(
    app,
    /preferLatestRunningEntry =\s*canRestoreInitial && Boolean\(latestTurnState\.active \|\| latestTurnState\.stopping\)/,
  );
  assert.match(
    app,
    /if \(!transientDiskPreview\) appTranscriptInitialRestorePending = false/,
  );
  assert.match(
    app,
    /storedPosition && !storedPosition\.atBottom && !shouldFollow/,
  );
  assert.match(
    app,
    /appTranscriptInitialRestorePending &&[\s\S]*!appTranscriptRunningRestoreFollowInitialized[\s\S]*appTranscriptRunningRestoreFollowInitialized = true;[\s\S]*status\.turnState\?\.active \|\| status\.turnState\?\.stopping[\s\S]*appTranscriptSubmitFollowActive = true;/,
  );
  assert.match(app, /appTranscriptRunningRestoreFollowInitialized = false;/);
  assert.match(app, /appServerView\.addEventListener\("pointerdown", stopAppTranscriptSubmitFollow/);
  assert.match(app, /appServerView\.addEventListener\("wheel", stopAppTranscriptSubmitFollow/);
});
