import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("catalog metadata uses a cached thread-scoped client over the shared App Server connection", () => {
  assert.match(
    serverSource,
    /async function withSharedAppServer\(run\) \{\s*const client = await sharedCatalogAppServer\(\);\s*return run\(client\);/,
  );
  assert.match(serverSource, /async function sharedCatalogAppServer\(\)/);
  assert.match(
    serverSource,
    /const client = createAgentAppServerClient\(WORKSPACE_ROOT, `catalog-\$\{cryptoRandomId\(\)\}`\)/,
  );
  assert.match(serverSource, /connection: sharedAgentAppServerConnection\(\)/);
  assert.match(serverSource, /const THREAD_CATALOG_CACHE_MS = Math\.max/);
  assert.match(serverSource, /AGENT_THREAD_CATALOG_CACHE_MS\) \|\| 2 \* 60_000/);
  assert.match(serverSource, /cachedThreadCatalogPage\(\{ archived \}\)/);
  assert.match(serverSource, /if \(cached\?\.promise\) return cached\.promise/);
  assert.match(serverSource, /thread-catalog-stale-fallback/);
});

test("catalog metadata never spawns a dedicated MCP-free App Server process", () => {
  assert.doesNotMatch(serverSource, /AGENT_SHARED_APP_SERVER|SHARED_APP_SERVER_ENABLED/);
  assert.doesNotMatch(serverSource, /AGENT_CATALOG_IDLE_MS|CATALOG_APP_SERVER_IDLE_MS/);
  assert.doesNotMatch(serverSource, /scheduleCatalogAppServerIdleStop|catalog-app-server-stopped/);
  assert.doesNotMatch(
    serverSource,
    /args:\s*\["app-server",\s*"-c",\s*"mcp_servers=\{\}"\]/,
  );
  assert.match(
    serverSource,
    /new CodexAppServerConnection\(\{[\s\S]*command: process\.env\.CODEX_APP_SERVER_COMMAND \|\| "codex"/,
  );
});
