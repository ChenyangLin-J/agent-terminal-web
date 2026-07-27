import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("control center aggregates Personal and Company Sessions behind account filters", async () => {
  const [page, app, styles] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-hosts.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="agent-host-tabs"[^>]*aria-label="Session 账号筛选"/);
  assert.match(page, /id="session-host"/);
  assert.match(page, /agent-hosts\.css\?v=/);
  assert.match(app, /await loadAgentHosts\(\);[\s\S]*await loadProjects\(\);/);
  assert.match(app, /function loadSessionsAcrossHosts\(path\)/);
  assert.match(app, /hosts\.map\(async \(host\)/);
  assert.match(app, /let activeAccountFilter = "all"/);
  assert.match(app, /function setAccountFilter\(filter\)/);
  assert.match(app, /\{ id: "all", label: "全部", type: "all", count: liveSessionsCache\.length \}/);
  assert.match(app, /function accountMatches\(session, filter = activeAccountFilter\)/);
  assert.match(app, /function hostSessionKey\(hostId, sessionId\)/);
  assert.match(app, /function agentHostApiUrl\(value, hostId = activeAgentHostId\)/);
  assert.match(app, /setCodexSessionFavorite\(session\.id, !session\.favorited, session\.hostId\)/);
  assert.match(app, /url\.searchParams\.set\("host", activeAgentHostId\)/);
  assert.match(app, /query = new URLSearchParams\(params\)/);
  assert.match(app, /params = \{ \.\.\.params, host: activeAgentHostId \}/);
  assert.match(app, /const scopedParams = \{ host: params\.host \|\| activeAgentHostId, \.\.\.params \}/);
  assert.match(app, /公司 Session 暂不支持从 Agent Web 传附件/);
  assert.match(styles, /\.agent-host-tabs button\.active/);
  assert.doesNotMatch(styles, /content: "远程"/);
});
