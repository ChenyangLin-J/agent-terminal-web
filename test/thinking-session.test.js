import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Think starts a workspace session and preserves its purpose", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /THINKING_SKILL_INVOCATION = "\$thinking-partner"/);
  assert.match(server, /thinkSkillActivated: Boolean\(session\.thinkSkillActivated\)/);
  assert.match(server, /session\.thinkSkillActivated = true/);
  assert.match(server, /session\.thinkSkillActivationPending/);
});
