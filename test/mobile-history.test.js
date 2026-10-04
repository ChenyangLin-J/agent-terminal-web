import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent displays dates and starts Codex in Beijing time", async () => {

  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /process\.env\.TZ = AGENT_TIME_ZONE/);
  assert.match(server, /timeZone: AGENT_TIME_ZONE/);
});
