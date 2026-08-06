import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("company Sessions skip personal memory and personal preview persistence", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(
    server,
    /async function appServerPersonalMemory\(session, prompt\) \{\s*if \(session\.hostId !== PERSONAL_AGENT_HOST\.id\) \{\s*return \{ additionalContext: undefined, citation: null \};/,
  );
  assert.match(
    server,
    /function persistCompletedSessionPreview\(session, result\) \{\s*if \(session\.hostId !== PERSONAL_AGENT_HOST\.id\) return null;/,
  );
  assert.match(
    server,
    /if \(session\.hostId === PERSONAL_AGENT_HOST\.id\) \{\s*personalMemoryScheduler\.schedule\(session\.sessionId \|\| session\.id\);/,
  );
  assert.match(
    server,
    /session\?\.hostId !== PERSONAL_AGENT_HOST\.id \|\|\s*!session\.sessionId \|\|/,
  );
  assert.match(
    server,
    /agentHost\.type === "local"\s*\? readCodexThreadRelationsFromFiles\(byId\.keys\(\)\)\s*: Promise\.resolve\(new Map\(\)\)/,
  );
  assert.match(server, /hostId: session\.hostId \|\| PERSONAL_AGENT_HOST\.id,[\s\S]*cwd: session\.cwd/);
  assert.match(
    server,
    /if \(session && session\.hostId !== requestedAgentHost\.id\) \{[\s\S]*logWebSocketReject\(req, "host-mismatch"[\s\S]*This Session belongs to a different Agent host\./,
  );
  assert.match(server, /function logWebSocketReject\(req, reason,[\s\S]*reason,[\s\S]*durationMs:/);
  assert.match(
    server,
    /if \(session\.hostId !== PERSONAL_AGENT_HOST\.id\) \{\s*query\.set\("host", session\.hostId\);\s*homeQuery\.set\("host", session\.hostId\);/,
  );
});

test("remote catalog failure never falls back to personal Session files", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(
    server,
    /if \(agentHost\.type === "ssh"\) \{\s*throw new Error\(`Remote Agent host \$\{agentHost\.label\} is unavailable:/,
  );
});

test("forks, archive actions, favorites, and UI state stay on their selected host", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /withStandaloneAppServer\(agentHost, async \(client\) =>/);
  assert.match(server, /setSessionArchived\(sourceThreadId, true, agentHost\)/);
  assert.match(server, /return path\.join\(AGENT_HOST_STATE_DIR, `\$\{agentHost\.id\}-favorites\.json`\)/);
  assert.match(server, /if \(normalizedHostId === PERSONAL_AGENT_HOST\.id\) return id;[\s\S]*`\$\{normalizedHostId\}:\$\{id\}`/);
});
