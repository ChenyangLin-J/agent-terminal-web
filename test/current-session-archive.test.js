import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the active Agent session can be archived from the responsive session header", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /const endLiveSession = archived && Boolean\(req\.body\?\.endLiveSession\)/);
  assert.match(server, /removePersistedWebSessionsForCodexSession\(id\)/);
  assert.match(
    server,
    /if \(endLiveSession\) \{[\s\S]*!session\.exited && session\.sessionId === id[\s\S]*killSessionTerminal\(session\)/,
  );
});
