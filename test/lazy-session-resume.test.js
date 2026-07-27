import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("saved and released Sessions open from disk before a runtime is attached", async () => {
  const [app, page] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function openSavedSessionPreview\(session\)[\s\S]*preview: "1"/);
  assert.match(app, /const previewOnly = Boolean\(session\.released \|\| session\.suspended\)/);
  assert.match(app, /attach: previewOnly \? "" : session\.id/);
  assert.match(
    app,
    /function openSessionInCurrentPage\(params\)[\s\S]*if \(scopedParams\.preview === "1"\) openSessionPreview\(scopedParams\);[\s\S]*else openSocket\(scopedParams\)/,
  );
  assert.match(app, /fetch\(`\/api\/session-preview\/\$\{encodeURIComponent\(sessionId\)\}`\)/);
  assert.match(app, /preview: activeSessionParams\.sessionId \? "仅查看 · 发送时恢复" : "发送第一条消息时创建"/);
  assert.doesNotMatch(page, /选择恢复方式|resume-engine-dialog/);
});

test("the first message activates a previewed Session and keeps permissions local until then", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

  assert.match(
    app,
    /if \(activeSessionPreviewOnly\) \{[\s\S]*pendingPreviewSubmission = \{ message, prompt, attachments \};[\s\S]*startSession\(\{/,
  );
  assert.match(app, /function flushPendingPreviewSubmission\(\)[\s\S]*if \(!send\(pending\.message\)\) return/);
  assert.match(
    app,
    /if \(pendingPreviewSubmission\) \{[\s\S]*openSessionPreview\(previewParams\);[\s\S]*消息和附件已保留，可以直接重试/,
  );
  assert.match(
    app,
    /function setAppAccess\(access\) \{[\s\S]*if \(activeSessionPreviewOnly\) \{[\s\S]*activeSessionParams\.access = activeAccessMode[\s\S]*syncPreviewSessionUrl\(\)/,
  );
  assert.match(app, /发送第一条消息时会使用这里选择的权限/);
  assert.match(app, /sendPromptButton\.disabled = !canCompose/);
  assert.match(app, /sendStatusButton\.disabled = !canCompose/);
  assert.match(app, /queuePromptButton\.disabled = !connected \|\| activeSessionPreviewOnly/);
  assert.match(app, /sessionMenu\.classList\.toggle\("hidden", activeSessionPreviewOnly\)/);
  assert.match(
    app,
    /if \(activeSessionPreviewOnly\) \{[\s\S]*commandName === "\/status"[\s\S]*"已暂停 · 仅查看"/,
  );
  assert.match(
    app,
    /function appSessionTaskStateValue\(\) \{[\s\S]*activeSessionPreviewOnly[\s\S]*label: "已暂停"/,
  );
});
