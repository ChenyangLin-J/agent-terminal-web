import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("Agent Web defaults to one on-demand App Server connection", () => {
  assert.match(serverSource, /const SHARED_APP_SERVER_ENABLED = process\.env\.AGENT_SHARED_APP_SERVER !== "0"/);
  assert.match(serverSource, /let agentHostAppServerPool = null/);
  assert.match(serverSource, /function sharedAgentAppServerConnection\(agentHost = PERSONAL_AGENT_HOST\)/);
  assert.match(serverSource, /sharedAgentAppServerPool\(\)\.connectionFor\(agentHost\)/);
  assert.match(serverSource, /connection: sharedAgentAppServerConnection\(agentHost\)/);
  assert.match(serverSource, /process\.once\("exit", \(\) => agentHostAppServerPool\?\.close\(\)\)/);
});

test("main sessions, side chats, and catalog metadata reuse the shared connection", () => {
  assert.match(serverSource, /const appServer = createAgentAppServerClient\(cwd, id, undefined, agentHost\)/);
  assert.match(serverSource, /const client = createAgentAppServerClient\(\s*session\.cwd,/);
  assert.match(serverSource, /resolveAgentHost\(AGENT_HOSTS, session\.hostId\) \|\| PERSONAL_AGENT_HOST/);
  assert.match(
    serverSource,
    /if \(SHARED_APP_SERVER_ENABLED\) \{\s*const client = await sharedCatalogAppServer\(\);\s*return run\(client\)/,
  );
  assert.match(serverSource, /releaseAgentAppServerClient\(session\.appServer, \{ interrupt: true \}\)/);
  assert.match(serverSource, /client\.request\("thread\/unsubscribe", \{ threadId \}\)/);
});

test("the legacy per-session mode remains available as an explicit rollback", () => {
  assert.match(serverSource, /if \(!SHARED_APP_SERVER_ENABLED \|\| client\.ownsConnection\)/);
  assert.match(
    serverSource,
    /args:\s*\["app-server",\s*"-c",\s*"mcp_servers=\{\}"\]/,
  );
});
