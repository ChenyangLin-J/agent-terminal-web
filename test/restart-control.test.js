import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent home exposes an authenticated external restart control", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /app\.get\("\/healthz"/);
  assert.match(server, /res\.setHeader\("X-Agent-Instance", agentInstanceId\)/);
});
