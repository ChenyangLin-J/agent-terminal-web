import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [page, app, styles] = await Promise.all([
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
]);

test("the default Agent home is a two-destination Session control center", () => {
  assert.match(page, /id="nav-control-center"[\s\S]*>[\s\S]*中控/);
  assert.match(page, /id="nav-current-session"[\s\S]*>[\s\S]*会话/);
  assert.equal((page.match(/class="app-nav-button/g) || []).length, 2);
  assert.match(page, /<h1>Agent 中控<\/h1>/);
  assert.match(page, /id="open-new-session"[\s\S]*新建/);
  assert.equal((page.match(/data-session-filter=/g) || []).length, 1);
  assert.match(page, /data-session-filter="all"[\s\S]*清除筛选/);
  assert.equal((page.match(/data-summary-filter=/g) || []).length, 3);
  assert.match(page, /data-summary-filter="pending"[\s\S]*待处理[\s\S]*需操作 · 0 新结果/);
  assert.match(page, /data-summary-filter="ready"[\s\S]*空闲[\s\S]*已查看 · 暂无下一步/);
  assert.match(page, /最近历史[\s\S]*id="control-history-count"/);
  assert.match(app, /function setControlCenterFilter\(filter\)/);
  assert.match(app, /function controlStatusFilterMatches\(kind\)/);
  assert.match(app, /function syncControlCenterFilterReset\(\)/);
  assert.match(app, /const LIVE_SESSIONS_FALLBACK_MS = 60_000/);
  assert.match(app, /const SESSION_CATALOG_FALLBACK_MS = 5 \* 60_000/);
  assert.match(app, /new EventSource\("\/api\/control-events"\)/);
  assert.match(app, /payload\.instanceId !== loadedAgentInstance[\s\S]*refreshLists\(\{ forceCatalog: true \}\)/);
  assert.match(app, /Date\.now\(\) - sessionCatalogLastRefreshedAt < SESSION_CATALOG_FALLBACK_MS/);
  assert.match(app, /if \(sessionCatalogRefreshPromise\) return sessionCatalogRefreshPromise/);
  assert.match(app, /sessionCatalogTimer = window\.setInterval\(refreshSessionCatalogs, SESSION_CATALOG_FALLBACK_MS\)/);
  assert.match(app, /sessionsTimer = window\.setInterval\(loadLiveSessions, LIVE_SESSIONS_FALLBACK_MS\)/);
  assert.match(
    app,
    /loadSessionsAcrossHosts\("\/api\/codex-sessions", \{\s*previousSessions: savedSessionsCache,?\s*\}\)[\s\S]*renderSavedCodexSessions\(sessions\)/,
  );
  assert.match(app, /Keep the last successful data while the list is temporarily unavailable/);
});

test("control center cards derive attention and progress from real Session state", () => {
  assert.match(app, /function liveSessionPresentation\(session\)/);
  assert.match(app, /session\?\.turnState\?\.interrupted/);
  assert.match(app, /session\?\.turnState\?\.active/);
  assert.match(app, /pendingServerRequestCount/);
  assert.match(app, /hasUnreadResult[\s\S]*kind: "unread"[\s\S]*label: "新结果"/);
  assert.match(app, /kind: "ready", state: "waiting", label: "空闲"/);
  assert.match(app, /if \(group\.kind === "ready"\) groupSessions\.sort\(compareIdleSessionOrder\)/);
  assert.match(
    app,
    /function compareIdleSessionOrder\(a, b\)[\s\S]*b\.lastActivityAt \|\| b\.startedAt[\s\S]*a\.lastActivityAt \|\| a\.startedAt/,
  );
  assert.match(app, /function liveSessionCurrentTask\(session/);
  assert.match(app, /turnState\?\.requirements/);
  assert.match(app, /return \[\.\.\.byKey\.values\(\)\]\.sort\(compareLiveSessionOrder\)/);
  assert.match(app, /function compareLiveSessionOrder\(a, b\)[\s\S]*startedAt/);
  assert.doesNotMatch(app, /Math\.random\(\).*progress/);
});

test("frequent Sessions can be starred and pinned above the control center", () => {
  assert.match(page, /id="favorite-sessions-section"[\s\S]*置顶 Session/);
  assert.match(page, /id="favorite-sessions-list"/);
  assert.match(app, /function renderFavoriteSessions\(\)/);
  assert.match(app, /className = "session-card-favorite"/);
  assert.match(app, /favoriteButton\.textContent = favorited \? "★" : "☆"/);
  assert.match(app, /\/api\/codex-sessions\/\$\{encodeURIComponent\(sessionId\)\}\/favorite/);
  assert.match(styles, /\.control-center-favorites \.sessions-list/);
  assert.match(
    styles,
    /@media \(max-width: 820px\)[\s\S]*\.control-center-favorites \.sessions-list,[\s\S]*grid-template-columns: 1fr/,
  );
});

test("saved Session history is compact, responsive, and renames inline", () => {
  assert.match(app, /const HISTORY_SESSIONS_PREVIEW_COUNT = 9/);
  assert.match(app, /nonLiveSessions\.slice\(0, HISTORY_SESSIONS_PREVIEW_COUNT\)/);
  assert.match(app, /compact: true,[\s\S]*actionIcon: "↗"/);
  assert.match(app, /className = "history-toggle"/);
  assert.match(app, /className = "session-card-title-editor hidden"/);
  assert.match(app, /Session 名称；按 Enter 保存，Esc 取消/);
  assert.match(app, /function saveSessionCardTitle\(session, title\)/);
  assert.doesNotMatch(app, /window\.prompt/);
  assert.match(styles, /\.session-card-more[\s\S]*position: relative/);
  assert.match(
    styles,
    /@media \(min-width: 1200px\)[\s\S]*\.control-center-history \.sessions-list \{[\s\S]*repeat\(3, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@media \(min-width: 721px\) and \(max-width: 1100px\)[\s\S]*\.control-center-history \.sessions-list \{[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.control-center-history \.sessions-list \{[\s\S]*grid-template-columns: 1fr/,
  );
});

test("desktop and Pad retain the compact switcher while phones open it as a drawer", () => {
  assert.match(page, /id="session-switcher"/);
  assert.match(styles, /@media \(min-width: 721px\)[\s\S]*grid-template-areas:[\s\S]*"switcher header"/);
  assert.match(
    styles,
    /@media \(min-width: 721px\) and \(max-width: 1100px\)[\s\S]*grid-template-columns: 176px minmax\(0, 1fr\)/,
  );
  assert.doesNotMatch(page, /session-switcher-host-tabs/);
  assert.doesNotMatch(app, /renderSessionSwitcherHostTabs|sessionSwitcherAccountFilter/);
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.app-primary-nav \{[\s\S]*grid-template-columns: repeat\(2, 1fr\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.session-switcher:not\(\.collapsed\) \{[\s\S]*position: fixed;[\s\S]*display: flex;/,
  );
  assert.match(
    app,
    /window\.matchMedia\("\(max-width: 720px\)"\)\.matches \? true : readSessionSwitcherCollapsed\(\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.app \{[\s\S]*grid-template-rows: minmax\(0, 1fr\) auto;[\s\S]*body\.session-active \.session-screen \{[\s\S]*height: 100%/,
  );
});

test("Session navigation and menus remain reversible in one page", () => {
  assert.doesNotMatch(page, /id="session-switcher-center"/);
  assert.doesNotMatch(app, /sessionSwitcherCenterButton/);
  assert.doesNotMatch(app, /session-live-status/);
  assert.doesNotMatch(styles, /\.session-live-status/);
  assert.match(app, /function openSessionFromList\(params\) \{\s*openSessionInCurrentPage\(params\);\s*\}/);
  assert.doesNotMatch(app, /function shouldOpenSessionInCurrentPage/);
  assert.match(
    app,
    /function showSessionScreen\(\)[\s\S]*document\.body\.classList\.add\("app-server-session"\)/,
  );
  assert.match(
    app,
    /controlCenterMenu\.addEventListener\("click"[\s\S]*controlCenterMenu\.removeAttribute\("open"\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*\.app-server-session \.app-session-tools \{\s*overflow: visible;/,
  );
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*\.app-session-more-menu \{[\s\S]*position: absolute;[\s\S]*bottom: calc\(100% \+ 8px\)/,
  );
});
