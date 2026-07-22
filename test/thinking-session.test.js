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
  assert.match(client, /startThinkButton\.addEventListener\("click", startThinkSession\)/);
  assert.match(client, /function startThinkSession\(\) \{[\s\S]*transport: transportSelect\.value[\s\S]*access: accessModeSelect\.value[\s\S]*purpose: "think"/);
  assert.match(client, /hasSessionIdOverride[\s\S]*sessionId: ""/);
  assert.match(client, /syncStartSelectionsFromUrl\(new URLSearchParams\(window\.location\.search\)\)/);
  assert.match(client, /function syncStartSelectionsFromUrl\(params\)[\s\S]*transportSelect\.value[\s\S]*accessModeSelect\.value/);
  assert.match(client, /purpose: status\.purpose === "think" \? "think" : ""/);
  assert.match(server, /THINKING_SKILL_INVOCATION = "\$thinking-partner"/);
  assert.match(server, /thinkSkillActivated: Boolean\(session\.thinkSkillActivated\)/);
  assert.match(server, /session\.thinkSkillActivated = true/);
  assert.match(server, /session\.thinkSkillActivationPending/);
});
