import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent Web exposes native search, persistent names, branching, subagent navigation, and audio input", async () => {
  const [server, client, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../lib/codex-app-server-client.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(client, /"thread\/search"/);
  assert.match(client, /"thread\/searchOccurrences"/);
  assert.match(client, /"thread\/fork"/);
  assert.match(client, /"thread\/list"/);
  assert.match(server, /setPersistedThreadName\(id, title, agentHost\)/);
  assert.match(server, /nativeThreadSessionMeta/);
  assert.match(server, /message\.type === "edit-and-fork"/);
  assert.match(server, /beforeTurnId/);
  assert.match(server, /forkAppServerSessionInBackground/);
  assert.match(server, /lastTurnId/);
  assert.match(server, /type: "localAudio"/);
  assert.match(server, /ancestorThreadId: session\.sessionId/);
  assert.match(server, /parentThreadId: session\.parentThreadId/);
  assert.match(server, /readCodexThreadRelationsFromFiles/);
  assert.match(server, /payload\.forked_from_id/);
  assert.match(server, /rememberAgentSessionRelation/);

  assert.match(page, /id="session-search-input"/);
  assert.match(page, /id="session-title-display"/);
  assert.match(page, /id="session-title-editor"/);
  assert.match(page, /id="session-title-input"/);
  assert.match(page, /id="thread-search-dialog"/);
  assert.match(page, /id="edit-fork-banner"/);
  assert.match(page, /id="app-session-agents"/);
  assert.match(page, /id="app-session-more"/);
  assert.match(app, /function searchSavedSessions\(\)/);
  assert.match(app, /function searchCurrentThread\(\)/);
  assert.match(app, /edit\.textContent = "编辑"/);
  assert.match(app, /fork\.textContent = "分支"/);
  assert.match(app, /原 Session 已归档/);
  assert.match(server, /await setSessionArchived\(sourceThreadId, true, agentHost\);[\s\S]*sourceArchived = true/);
  assert.match(server, /sourceArchived,[\s\S]*deliveryMode/);
  assert.match(app, /function beginCurrentSessionRename\(\)/);
  assert.match(app, /function saveCurrentSessionRename\(\)/);
  assert.match(app, /saveCodexSessionTitle\(sessionId, title\)/);
  assert.match(app, /const canBranch = item\.type === "user"/);
  assert.doesNotMatch(app, /const canFork =[\s\S]*item\.type === "assistant"/);
  assert.match(app, /function renderAppSubagents/);
  assert.match(app, /sessionId: agent\.id,[\s\S]{0,300}sourceSession: activeSessionId/);
  assert.match(app, /sessionId: item\.agentThreadId,[\s\S]{0,300}sourceSession: activeSessionId/);
  assert.match(app, /sourceSession\.searchParams|previewPath\.searchParams\.set\("sourceSession"/);
  assert.match(app, /function normalizeSessionNavigation[\s\S]*sourceSession,[\s\S]*preview: sourceSession \|\| host === "personal"/);
  assert.match(app, /"打开主 Agent"/);
  assert.match(server, /function readLiveSessionPreview/);
  assert.match(server, /sourceSession\.appServer\.listThreadTurns/);
  assert.doesNotMatch(server, /readLiveSessionPreview[\s\S]{0,600}resumeThread/);
  assert.match(styles, /\.thread-search-dialog/);
  assert.match(styles, /\.app-transcript-item-actions/);
  assert.match(styles, /\.app-transcript-item\.has-transcript-actions:hover \.app-transcript-item-actions/);
  assert.match(styles, /\.app-session-more-menu/);
  assert.match(styles, /\.session-title-display:not\(:disabled\):hover \.session-title-rename-hint/);
  assert.match(styles, /\.edit-fork-banner \{[\s\S]*grid-column: 1 \/ -1/);
  assert.match(styles, /\.app-transcript-item\.is-edit-source/);
});
