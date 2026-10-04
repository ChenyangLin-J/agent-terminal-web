import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent Web exposes native search, persistent names, branching, subagent navigation, and audio input", async () => {
  const [server, client] = await Promise.all([
readFile(new URL("../server.js", import.meta.url), "utf8"),
readFile(new URL("../lib/codex-app-server-client.js", import.meta.url), "utf8")
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
  assert.match(server, /readCodexThreadRelationsFromFiles/);
  assert.match(server, /payload\.forked_from_id/);
  assert.match(server, /rememberAgentSessionRelation/);

  assert.match(server, /await setSessionArchived\(sourceThreadId, true\);[\s\S]*sourceArchived = true/);
  assert.match(server, /sourceArchived,[\s\S]*deliveryMode/);

  assert.match(server, /function readLiveSessionPreview/);
  assert.match(server, /sourceSession\.appServer\.listThreadTurns/);
  assert.doesNotMatch(server, /readLiveSessionPreview[\s\S]{0,600}resumeThread/);

});
