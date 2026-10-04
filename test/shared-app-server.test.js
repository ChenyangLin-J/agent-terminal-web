import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("Agent Web uses one on-demand shared App Server connection", () => {
  assert.match(serverSource, /let sharedLocalAppServerConnection = null/);
  assert.match(serverSource, /function sharedAgentAppServerConnection\(\)/);
  assert.match(
    serverSource,
    /if \(sharedLocalAppServerConnection && !sharedLocalAppServerConnection\.closed\) \{\s*return sharedLocalAppServerConnection;/,
  );
  assert.match(
    serverSource,
    /new CodexAppServerConnection\(\{[\s\S]*args: DEFAULT_APP_SERVER_ARGS,[\s\S]*cwd: WORKSPACE_ROOT/,
  );
  assert.match(serverSource, /connection: sharedAgentAppServerConnection\(\)/);
  assert.match(
    serverSource,
    /process\.once\("exit", \(\) => \{\s*platformKernel\?\.close\(\);\s*sharedLocalAppServerConnection\?\.close\(\);/,
  );
  assert.doesNotMatch(serverSource, /AGENT_SHARED_APP_SERVER/);
  assert.doesNotMatch(serverSource, /SHARED_APP_SERVER_ENABLED|agentHostAppServerPool/);
});

test("main sessions, side chats, and catalog metadata reuse the shared connection", () => {
  assert.match(
    serverSource,
    /const appServer = createAgentAppServerClient\(cwd, id, \{\s*runtimeKernel: usePlatformKernel \? "platform" : "legacy",\s*\}\)/,
  );
  assert.match(
    serverSource,
    /const client = createAgentAppServerClient\(\s*session\.cwd,\s*`side-\$\{session\.id\}-\$\{cryptoRandomId\(\)\}`,?\s*\)/,
  );
  assert.match(
    serverSource,
    /async function withSharedAppServer\(run\) \{\s*const client = await sharedCatalogAppServer\(\);\s*return run\(client\);/,
  );
  assert.match(serverSource, /releaseAgentAppServerClient\(session\.appServer, \{ interrupt: true \}\)/);
  assert.match(serverSource, /client\.request\("thread\/unsubscribe", \{ threadId \}\)/);
});

test("releasing a thread-scoped client never closes the shared connection", () => {
  assert.match(
    serverSource,
    /function releaseAgentAppServerClient\(client, \{ interrupt = false \} = \{\}\) \{\s*if \(!client \|\| client\.closed\) return;\s*if \(client\.ownsConnection\) \{\s*client\.close\(\);\s*return;/,
  );
  assert.doesNotMatch(serverSource, /args:\s*\["app-server",\s*"-c",\s*"mcp_servers=\{\}"\]/);
});
