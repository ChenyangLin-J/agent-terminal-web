import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the desktop and Pad Session switcher collapses and exposes contextual actions", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.ok(server.includes('app.post("/api/sessions/:id/end"'));
  assert.match(
    server,
    /session && !session\.exited[\s\S]*killSessionTerminal\(session\)/,
  );
  assert.match(server, /res\.json\(\{ id, ended: true, session: publicSession\(session\) \}\)/);
  assert.match(
    server,
    /listDetachedSessions\(\)\.find\(\(candidate\) => candidate\.id === id\)[\s\S]*removePersistedWebSession\(id\)/,
  );
});
