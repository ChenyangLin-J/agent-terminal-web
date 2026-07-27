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

  assert.match(page, /id="session-switcher-toggle"[\s\S]*aria-expanded="false"[\s\S]*展开快速切换/);
  assert.match(app, /const SESSION_SWITCHER_COLLAPSED_STORE_KEY/);
  assert.match(app, /return stored === null \? true : stored !== "0"/);
  assert.match(app, /function setSessionSwitcherCollapsed\(collapsed/);
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \{[\s\S]*grid-template-columns: 42px minmax\(0, 1fr\)/);
  assert.match(styles, /\.session-switcher\.collapsed > \.session-switcher-list,[\s\S]*display: none/);
  assert.match(app, /row\.className = "session-switcher-row"/);
  assert.match(app, /actions\.className = "session-switcher-actions"/);
  assert.match(app, /actions\.open = sessionKey === openSessionSwitcherActionId/);
  assert.match(app, /openSessionSwitcherActionId = sessionKey/);
  assert.match(app, /summary\.textContent = "⋮"/);
  assert.match(app, /archive\.textContent = "归档"/);
  assert.match(app, /end\.textContent = "结束"/);
  assert.match(app, /function archiveSessionFromSwitcher\(session\)/);
  assert.match(app, /function endSessionFromSwitcher\(session\)/);
  assert.ok(
    app.includes(
      'fetch(agentHostApiUrl(`/api/sessions/${encodeURIComponent(webSessionId)}/end`), {\n      method: "POST"',
    ),
  );
  assert.match(
    styles,
    /\.session-switcher-row:hover \.session-switcher-actions > summary,[\s\S]*opacity: 1;[\s\S]*pointer-events: auto;/,
  );
  assert.match(styles, /@media \(hover: none\)[\s\S]*\.session-switcher-actions > summary/);
  assert.ok(server.includes('app.post("/api/sessions/:id/end"'));
  assert.match(
    server,
    /session && !session\.exited && session\.hostId === agentHost\.id[\s\S]*killSessionTerminal\(session\)/,
  );
  assert.match(
    server,
    /listDetachedSessions\(\)\.find\([\s\S]*candidate\.hostId === agentHost\.id[\s\S]*removePersistedWebSession\(id\)/,
  );
});
