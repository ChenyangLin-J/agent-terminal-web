import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("control center scopes projects and Sessions through Personal and Company host tabs", async () => {
  const [page, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-hosts.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="agent-host-tabs"[^>]*aria-label="Codex 执行主机"/);
  assert.match(page, /agent-hosts\.css\?v=/);
  assert.match(app, /await loadAgentHosts\(\);[\s\S]*await loadProjects\(\);/);
  assert.match(app, /url\.searchParams\.set\("host", activeAgentHostId\)/);
  assert.match(app, /query = new URLSearchParams\(params\)/);
  assert.match(app, /params = \{ \.\.\.params, host: activeAgentHostId \}/);
  assert.match(app, /const scopedParams = \{ host: params\.host \|\| activeAgentHostId, \.\.\.params \}/);
  assert.match(app, /公司 Session 暂不支持从 Agent Web 传附件/);
  assert.match(styles, /\.agent-host-tabs button\.active/);
});
