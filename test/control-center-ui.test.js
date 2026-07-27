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
  assert.equal((page.match(/data-summary-filter=/g) || []).length, 5);
  assert.match(page, /data-summary-filter="unread"[\s\S]*新结果/);
  assert.match(page, /data-summary-filter="ready"[\s\S]*空闲/);
  assert.match(app, /function setControlCenterFilter\(filter\)/);
  assert.match(app, /function syncControlCenterFilterReset\(\)/);
});

test("control center cards derive attention and progress from real Session state", () => {
  assert.match(app, /function liveSessionPresentation\(session\)/);
  assert.match(app, /session\?\.turnState\?\.interrupted/);
  assert.match(app, /session\?\.turnState\?\.active/);
  assert.match(app, /pendingServerRequestCount/);
  assert.match(app, /hasUnreadResult[\s\S]*kind: "unread"[\s\S]*label: "新结果"/);
  assert.match(app, /kind: "ready", state: "waiting", label: "空闲"/);
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

test("desktop and Pad retain the compact switcher while phones use bottom navigation", () => {
  assert.match(page, /id="session-switcher"/);
  assert.match(styles, /@media \(min-width: 721px\)[\s\S]*grid-template-areas:[\s\S]*"switcher header"/);
  assert.match(
    styles,
    /@media \(min-width: 721px\) and \(max-width: 1100px\)[\s\S]*grid-template-columns: 176px minmax\(0, 1fr\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 720px\)[\s\S]*\.app-primary-nav \{[\s\S]*grid-template-columns: repeat\(2, 1fr\)/,
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
    /function showSessionScreen\(\)[\s\S]*document\.body\.classList\.toggle\("app-server-session", activeTransport === "app-server"\)/,
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
