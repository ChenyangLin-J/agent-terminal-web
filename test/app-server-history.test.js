import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server resume restores structured history without terminal replay", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /resumeAppServerThread\(session, launch, \{/);
  assert.match(server, /initialTurnsPage: \{[\s\S]*limit: APP_INITIAL_TURN_LIMIT/);
  assert.match(server, /const recentPage = resumed\.initialTurnsPage/);
  assert.match(server, /restoreAppServerTranscript\(session, \{ \.\.\.thread, turns: recentPage\?\.data \|\| \[\] \}, \{ resumed: true \}\)/);
  assert.match(server, /restoreResumedActiveTurnState\(session, recentPage\?\.data \|\| \[\]\)/);
  assert.match(
    server,
    /function restoreResumedActiveTurnState\(session, turns\)[\s\S]*session\.appServer\?\.activeTurnId[\s\S]*state\.active = true/,
  );
  assert.match(server, /for \(const turn of turns\)[\s\S]*for \(const item of Array\.isArray\(turn\?\.items\)/);
  assert.match(server, /send\(ws, "app-transcript", publicAppTranscript\(session\)\)/);
  assert.match(server, /item\.type === "userMessage"/);
  assert.match(server, /item\.type === "agentMessage"/);
  assert.match(server, /item\.type === "commandExecution"/);
  assert.match(server, /item\.type === "dynamicToolCall" && appServerToolLeafName\(item\) === "exec"/);
  assert.match(server, /return commandDisplayText\(item\.cmd \|\| item\.command\)/);

  assert.match(server, /async function loadEarlierAppServerHistory\(session\)/);
  assert.match(server, /cursor: session\.restoredHistoryCursor/);
  assert.match(server, /prependAppServerTranscript\(session, turns\)/);

  assert.match(server, /extractSessionConversationFromJsonl\(file, \{[\s\S]*limit: APP_INITIAL_TURN_LIMIT/);

  assert.match(server, /pendingStartupPrompts: \[\]/);
  assert.match(server, /capabilities: \{[\s\S]*startupQueue: true/);
  assert.match(server, /void drainAppServerStartupPrompts\(session\)/);
  assert.match(server, /kind: "startup-submit"/);

  assert.match(
    server,
    /transport: APP_SERVER_TRANSPORT,[\s\S]*args: \["app-server"\]/,
  );
  assert.doesNotMatch(server, /USE_TMUX_SESSIONS|transport=terminal|node-pty/);

  assert.match(server, /memoryCitation: normalizeMemoryCitation\(item\.memoryCitation\)/);
  assert.match(server, /memoryCitation: mergeMemoryCitations\(/);
  assert.match(
    server,
    /additionalContext: appServerTurnAdditionalContext\(session, personalMemory\.additionalContext\)/,
  );

});
