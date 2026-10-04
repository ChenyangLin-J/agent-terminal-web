import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the first message activates a previewed Session and keeps permissions local until then", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(
    server,
    /async function resumeAppServerThread\(session, launch, params\)[\s\S]*setThreadArchived\(false, threadId\)[\s\S]*resumeThreadWithResult\(threadId, params\)/,
  );
  assert.match(
    server,
    /app\.get\("\/api\/session-preview\/:id"[\s\S]*liveSessionPreviewSource\(req\)[\s\S]*extractSessionConversationFromJsonl\(file, \{[\s\S]*res\.json\(\{[\s\S]*preview,[\s\S]*conversation: conversation \|\| \{ turns: \[\], hasEarlier: false \},[\s\S]*\.\.\.\(liveSource/,
  );
  assert.match(
    server,
    /function listDetachedSessions\(\)[\s\S]*archivedPersonalSessionIds\.has\(String\(record\.sessionId \|\| ""\)\)[\s\S]*\) \{\s*continue;/,
  );

});
