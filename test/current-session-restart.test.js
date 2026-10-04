import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("session restart resumes only the current Codex session", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /app\.post\("\/api\/sessions\/:id\/restart"/);
  assert.match(server, /if \(!session \|\| session\.exited\)/);
  assert.match(server, /session\.ready = false;\s*session\.exited = true;/);
  assert.match(server, /killSessionTerminal\(session\);\s*res\.json\(\{ session: restart \}\)/);

});
