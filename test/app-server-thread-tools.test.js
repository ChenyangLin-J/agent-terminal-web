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
  assert.match(server, /setPersistedThreadName\(id, title\)/);
  assert.match(server, /nativeThreadSessionMeta/);
  assert.match(server, /message\.type === "edit-and-fork"/);
  assert.match(server, /beforeTurnId/);
  assert.match(server, /forkAppServerSessionInBackground/);
  assert.match(server, /lastTurnId/);
  assert.match(server, /type: "localAudio"/);
  assert.match(server, /ancestorThreadId: session\.sessionId/);
  assert.match(server, /parentThreadId: session\.parentThreadId/);

  assert.match(page, /id="session-search-input"/);
  assert.match(page, /id="thread-search-dialog"/);
  assert.match(page, /id="edit-fork-banner"/);
  assert.match(page, /id="app-session-agents"/);
  assert.match(app, /function searchSavedSessions\(\)/);
  assert.match(app, /function searchCurrentThread\(\)/);
  assert.match(app, /"编辑并分支"/);
  assert.match(app, /"从这里分支"/);
  assert.match(app, /function renderAppSubagents/);
  assert.match(app, /"打开主 Agent"/);
  assert.match(styles, /\.thread-search-dialog/);
  assert.match(styles, /\.app-transcript-item-actions/);
});
