import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("catalog metadata uses the shared App Server by default", () => {
  assert.match(
    serverSource,
    /if \(SHARED_APP_SERVER_ENABLED\) \{\s*const client = await sharedCatalogAppServer\(\);\s*return run\(client\)/,
  );
  assert.match(
    serverSource,
    /SHARED_APP_SERVER_ENABLED\s*\?\s*createAgentAppServerClient\(WORKSPACE_ROOT,/,
  );
  assert.match(serverSource, /const THREAD_CATALOG_CACHE_MS = Math\.max/);
  assert.match(serverSource, /cachedThreadCatalogPage\(\{ archived, agentHost \}\)/);
  assert.match(serverSource, /if \(cached\?\.promise\) return cached\.promise/);
  assert.match(serverSource, /thread-catalog-stale-fallback/);
});

test("the rollback-only hidden Catalog disables MCP and stops when idle", () => {
  assert.match(
    serverSource,
    /args:\s*\["app-server",\s*"-c",\s*"mcp_servers=\{\}"\]/,
  );
  assert.match(serverSource, /AGENT_CATALOG_IDLE_MS/);
  assert.match(serverSource, /scheduleCatalogAppServerIdleStop\(\)/);
  assert.match(serverSource, /catalog-app-server-stopped/);
});
