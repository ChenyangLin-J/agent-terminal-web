import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  latestPersistedSessionsByCodexId,
  persistedAccessForCodexSession,
  preferredAccessForCodexSession,
} from "../lib/session-access.js";

test("a resumed Codex session keeps its most recent valid access mode", () => {
  const records = {
    old: {
      sessionId: "session-1",
      access: "safe",
      lastActivityAt: "2026-07-20T10:00:00.000Z",
    },
    legacy: {
      sessionId: "session-1",
      lastActivityAt: "2026-07-21T12:00:00.000Z",
    },
    current: {
      sessionId: "session-1",
      access: "full",
      lastActivityAt: "2026-07-21T11:00:00.000Z",
    },
  };

  assert.equal(latestPersistedSessionsByCodexId(records).get("session-1"), records.current);
  assert.equal(persistedAccessForCodexSession(records, "session-1"), "full");
  assert.equal(persistedAccessForCodexSession(records, "new-session"), null);
  assert.equal(
    preferredAccessForCodexSession({ "session-1": { access: "safe" } }, records, "session-1"),
    "safe",
  );
  assert.equal(preferredAccessForCodexSession({ "session-1": { access: "full" } }, {}, "session-1"), "full");
});

test("Saved Sessions and direct resume defer to persisted access", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(app, /function openSavedSessionPreview\(session\)[\s\S]*access: session\.access === "full" \? "full" : "safe"/);
  assert.match(app, /const access = params\.get\("access"\) === "safe" \? "safe" : "full"/);
  assert.match(app, /activeAccessMode = params\.access === "safe" \? "safe" : "full"/);
  assert.match(server, /savedAgentSessionAccess\(sessionId, agentHost\) \|\| FULL_ACCESS_MODE/);
  assert.match(server, /savedSetting\.access \|\| persistedByCodexId\.get\(meta\.id\)\?\.access/);
  assert.match(server, /rememberAgentSessionAccess\(session\.sessionId, session\.access, session\.hostId\)/);
});
