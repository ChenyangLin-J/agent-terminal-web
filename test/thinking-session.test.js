import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Think starts a workspace session and preserves its purpose", async () => {
  const [page, styles, client, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/thinking-session.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="start-think"[^>]*>Think<\/button>/);
  assert.match(page, /thinking-session\.css\?v=20260716-1/);
  assert.match(styles, /grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(client, /startSession\(\{ cwd: "\.", mode: "new", purpose: "think" \}\)/);
  assert.match(client, /purpose: status\.purpose === "think" \? "think" : ""/);
  assert.match(server, /THINKING_SKILL_INVOCATION = "\$thinking-partner"/);
  assert.match(server, /thinkSkillActivated: Boolean\(session\.thinkSkillActivated\)/);
  assert.match(server, /session\.thinkSkillActivated = true/);
  assert.match(server, /session\.thinkSkillActivationPending/);
});
