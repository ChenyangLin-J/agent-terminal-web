import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../server.js", import.meta.url), "utf8");

test("the hidden catalog App Server disables MCP providers", () => {
  assert.match(
    serverSource,
    /args:\s*\["app-server",\s*"-c",\s*"mcp_servers=\{\}"\]/,
  );
});

test("the hidden catalog App Server is reclaimed after an idle interval", () => {
  assert.match(serverSource, /AGENT_CATALOG_IDLE_MS/);
  assert.match(serverSource, /scheduleCatalogAppServerIdleStop\(\)/);
  assert.match(serverSource, /catalog-app-server-stopped/);
});
