import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the desktop and Pad Session switcher collapses and exposes contextual actions", async () => {
  const [server, page, app, styles, entry, hostStyles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/session-list-entry.jsx", import.meta.url), "utf8"),
    readFile(new URL("../public/session-list-host.css", import.meta.url), "utf8"),
  ]);

  assert.match(page, /id="session-switcher-core"/);
  assert.match(page, /id="session-workspace-core"/);
  assert.match(page, /session-list-core\.css\?v=0\.6\.12/);
  assert.match(page, /session-list-core\.js\?v=0\.6\.12/);
  assert.match(page, /id="session-switcher-open"[\s\S]*aria-label="展开快速切换"/);
  assert.match(entry, /import \{ SessionList, SessionWorkspace \} from "@agent-workbench\/platform\/ui"/);
  assert.match(entry, /onFavorite: \(session, favorited\)/);
  assert.match(entry, /onFullTextSearch: \(query\)/);
  assert.match(entry, /onOpenHistory:/);
  assert.match(entry, /onArchive: \(session, archived\)/);
  assert.match(entry, /onEnd: \(session\)/);
  assert.match(entry, /className="agent-core-host-filters"/);
  assert.match(entry, /<SessionWorkspace/);
  assert.match(entry, /window\.AgentSessionWorkspace = \{ render: renderWorkspace, unmount \}/);
  assert.match(entry, /onUploadAttachments: \(files\)/);
  assert.match(entry, /documentResourceUrl: agentDocumentResourceUrl/);
  assert.match(entry, /onSaveDocument: \(change\)/);
  assert.match(app, /const SESSION_SWITCHER_COLLAPSED_STORE_KEY/);
  assert.match(app, /const PLATFORM_SESSION_CANARY_STORE_KEY/);
  assert.match(app, /function platformSessionWorkspaceSnapshot\(\)/);
  assert.match(app, /function uploadPlatformSessionAttachments\(files\)/);
  assert.match(app, /function openPlatformLocalFile\(filePath, attachment = null\)/);
  assert.match(app, /function savePlatformMarkdownDocument\(change = \{\}\)/);
  assert.match(server, /app\.post\("\/api\/local-markdown"/);
  assert.match(app, /return stored === null \? false : stored !== "0"/);
  assert.match(app, /function setSessionSwitcherCollapsed\(collapsed/);
  assert.match(app, /window\.AgentSessionList\?\.render\(sessionSwitcherCore/);
  assert.match(app, /groupMode: "attention"/);
  assert.match(app, /searchableText: liveSessionCurrentTask\(session\)/);
  assert.match(app, /sortOrder,/);
  assert.match(app, /favorited: Boolean\(session\.favorited\)/);
  assert.match(app, /sessionSwitcherAccountFilter = detail\.hostId \|\| "all"/);
  assert.match(app, /detail\.type === "full-text-search"/);
  assert.match(app, /detail\.type === "history"/);
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \.session-switcher \{\s*display: none/);
  assert.match(
    styles,
    /\.session-screen\.session-switcher-collapsed \.session-header \{[\s\S]*column-gap: 12px;[\s\S]*padding-left: 12px;/,
  );
  assert.match(styles, /\.session-screen\.session-switcher-collapsed \.session-switcher-open \{\s*display: grid/);
  assert.match(hostStyles, /#session-switcher-core/);
  assert.match(hostStyles, /\.session-workspace-core/);
  assert.match(hostStyles, /\.session-screen:not\(\.session-switcher-collapsed\) \.session-workspace-core/);
  assert.match(hostStyles, /--cwu-surface: #0c1016/);
  assert.doesNotMatch(app, /row\.className = "session-switcher-row"/);
  assert.doesNotMatch(app, /function renderSessionSwitcherHostTabs\(\)/);
  assert.match(app, /function archiveSessionFromSwitcher\(session\)/);
  assert.match(app, /function endSessionFromSwitcher\(session\)/);
  assert.match(
    app,
    /function archiveSessionFromSwitcher\(session\)[\s\S]*if \(isCurrentSession\) \{[\s\S]*openNewSessionDraft\(/,
  );
  assert.match(
    app,
    /function archiveSessionFromSwitcher\(session\)[\s\S]*agentHostApiUrl\([\s\S]*session\.hostId \|\| activeAgentHostId/,
  );
  assert.match(
    app,
    /agentHostApiUrl\(`\/api\/sessions\/\$\{encodeURIComponent\(webSessionId\)\}\/end`, session\.hostId \|\| activeAgentHostId\)/,
  );
  assert.match(
    app,
    /function endSessionFromSwitcher\(session\)[\s\S]*if \(isCurrentSession\) \{[\s\S]*openNewSessionAfterEnd\(\{/,
  );
  assert.match(
    app,
    /async function endSession\(\)[\s\S]*agentHostApiUrl\([\s\S]*\/api\/sessions\/\$\{encodeURIComponent\(webSessionId\)\}\/end[\s\S]*openNewSessionAfterEnd\(\{/,
  );
  assert.match(
    app,
    /function openNewSessionAfterEnd\([\s\S]*applyControlSessionEvent\(endedSession\)[\s\S]*openNewSessionDraft\(\{/,
  );
  assert.match(app, /Session 已结束 · 发送消息时恢复/);
  assert.ok(server.includes('app.post("/api/sessions/:id/end"'));
  assert.match(
    server,
    /session && !session\.exited && session\.hostId === agentHost\.id[\s\S]*killSessionTerminal\(session\)/,
  );
  assert.match(server, /res\.json\(\{ id, ended: true, session: publicSession\(session\) \}\)/);
  assert.match(
    server,
    /listDetachedSessions\(\)\.find\([\s\S]*candidate\.hostId === agentHost\.id[\s\S]*removePersistedWebSession\(id\)/,
  );
});
