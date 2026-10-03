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
  assert.match(
    app,
    /const previewPath = new URL\(`\/api\/session-preview\/\$\{encodeURIComponent\(sessionId\)\}`[\s\S]*agentHostApiUrl\(\s*`\$\{previewPath\.pathname\}\$\{previewPath\.search\}`,\s*activeSessionParams\.host \|\| activeAgentHostId/,
  );
  assert.match(
    app,
    /function openSavedSessionPreview\(session\)[\s\S]*host: hostId,[\s\S]*preview: "1"/,
  );
  assert.match(
    app,
    /function openSessionPreview\(params = \{\}\)[\s\S]*if \(activeSessionParams\.sessionId\) \{\s*void loadSessionPreview/,
  );
  assert.match(app, /const resumesRenderedPreview =[\s\S]*appTranscriptSource === "disk"/);
  assert.match(app, /if \(!resumesRenderedPreview\) renderAppTranscript\(\)/);
  assert.match(
    app,
    /if \(!resumesRenderedPreview && params\.sessionId && activeAgentHostId === "personal"\)/,
  );
  assert.match(app, /function transcriptAnchorAliases\(previousItems, nextItems\)/);
  assert.match(
    app,
    /preview: readOnlySubagentPreview[\s\S]{0,200}activeSessionParams\.sessionId[\s\S]{0,100}"仅查看 · 发送时恢复"[\s\S]{0,100}"发送第一条消息时创建"/,
  );
  assert.doesNotMatch(page, /选择恢复方式|resume-engine-dialog/);
});

test("the first message activates a previewed Session and keeps permissions local until then", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(
    app,
    /if \(activeSessionPreviewOnly\) \{[\s\S]*pendingPreviewSubmission = \{ message, prompt, attachments, preserveComposer: isInlineReply \};[\s\S]*startSession\(\{/,
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
    server,
    /async function resumeAppServerThread\(session, launch, params\)[\s\S]*setThreadArchived\(false, threadId\)[\s\S]*resumeThreadWithResult\(threadId, params\)/,
  );
  assert.match(
    server,
    /app\.get\("\/api\/session-preview\/:id"[\s\S]*agentHost\.type !== "local"[\s\S]*readAppServerSessionConversation\(client, id,[\s\S]*res\.json\(\{ preview, conversation, \.\.\.\(liveSource/,
  );
  assert.match(
    server,
    /function listDetachedSessions\(\)[\s\S]*archivedPersonalSessionIds\.has\(String\(record\.sessionId \|\| ""\)\)[\s\S]*\) \{\s*continue;/,
  );
  assert.match(
    app,
    /async function archiveCodexSession\(session, archived\)[\s\S]*if \(!archived\) openSavedSessionPreview\(\{ \.\.\.session, archived: false \}\)/,
  );
  assert.match(
    app,
    /if \(activeSessionPreviewOnly\) \{[\s\S]*commandName === "\/status"[\s\S]*"已暂停 · 仅查看"/,
  );
  assert.match(
    app,
    /function appSessionTaskStateValue\(\) \{[\s\S]*activeSessionPreviewOnly[\s\S]*label: "已暂停"/,
  );
});

test("idle and paused Sessions share the same inactive status colors", async () => {
  const styles = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  const idleSwitcherColor = styles.match(
    /\.session-switcher-dot \{[\s\S]*?background: ([^;]+);/,
  )?.[1];
  const pausedSwitcherColor = styles.match(
    /\.session-switcher-item\[data-state="released"\] \.session-switcher-dot \{[\s\S]*?background: ([^;]+);/,
  )?.[1];

  assert.ok(idleSwitcherColor);
  assert.equal(pausedSwitcherColor, idleSwitcherColor);
  assert.doesNotMatch(styles, /\.app-session-task-control\[data-state="preview"\]\s*\{/);
});
