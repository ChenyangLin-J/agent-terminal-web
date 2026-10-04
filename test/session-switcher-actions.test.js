import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the desktop and Pad Session switcher collapses and exposes contextual actions", async () => {
  const [server, page, app, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="session-switcher-toggle"[\s\S]*aria-label="收起快速切换"/);
  assert.match(page, /id="session-switcher-open"[\s\S]*aria-label="展开快速切换"/);
  assert.doesNotMatch(page, /session-switcher-host-tabs/);
  assert.match(app, /const SESSION_SWITCHER_COLLAPSED_STORE_KEY/);
  assert.match(app, /return stored === null \? false : stored !== "0"/);
  assert.match(app, /function setSessionSwitcherCollapsed\(collapsed/);
  assert.doesNotMatch(app, /renderSessionSwitcherHostTabs|sessionSwitcherAccountFilter|agentHostApiUrl/);
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \.session-switcher \{\s*display: none/);
  assert.match(
    styles,
    /\.session-screen\.session-switcher-collapsed \.session-header \{[\s\S]*column-gap: 12px;[\s\S]*padding-left: 12px;/,
  );
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \.session-switcher-open \{\s*display: grid/);
  assert.match(app, /row\.className = "session-switcher-row"/);
  assert.match(app, /actions\.className = "session-switcher-actions"/);
  assert.match(app, /actions\.open = sessionKey === openSessionSwitcherActionId/);
  assert.match(app, /openSessionSwitcherActionId = sessionKey/);
  assert.match(app, /summary\.textContent = "⋮"/);
  assert.match(app, /archive\.textContent = "归档"/);
  assert.match(app, /end\.textContent = "结束"/);
  assert.match(app, /function archiveSessionFromSwitcher\(session\)/);
  assert.match(app, /function endSessionFromSwitcher\(session\)/);
  assert.match(
    app,
    /function archiveSessionFromSwitcher\(session\)[\s\S]*if \(isCurrentSession\) \{[\s\S]*openNewSessionDraft\(/,
  );
  assert.match(
    app,
    /function archiveSessionFromSwitcher\(session\)[\s\S]*`\/api\/codex-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/archive`/,
  );
  assert.match(
    app,
    /function endSessionFromSwitcher\(session\)[\s\S]*`\/api\/sessions\/\$\{encodeURIComponent\(webSessionId\)\}\/end`/,
  );
  assert.match(
    app,
    /function endSessionFromSwitcher\(session\)[\s\S]*if \(isCurrentSession\) \{[\s\S]*openNewSessionAfterEnd\(\{/,
  );
  assert.match(
    app,
    /async function endSession\(\)[\s\S]*`\/api\/sessions\/\$\{encodeURIComponent\(webSessionId\)\}\/end`[\s\S]*openNewSessionAfterEnd\(\{/,
  );
  assert.match(
    app,
    /function openNewSessionAfterEnd\([\s\S]*applyControlSessionEvent\(endedSession\)[\s\S]*openNewSessionDraft\(\{/,
  );
  assert.match(app, /Session 已结束 · 发送消息时恢复/);
  assert.match(
    styles,
    /\.session-switcher-row:hover \.session-switcher-actions > summary,[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/,
  );
  assert.match(styles, /@media \(hover: none\)[\s\S]*\.session-switcher-actions > summary/);
  assert.doesNotMatch(styles, /\.session-switcher-host-tabs/);
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
