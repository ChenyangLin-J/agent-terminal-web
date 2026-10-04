import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the active Agent session can be archived from the responsive session header", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(
    page,
    /id="disconnect"[\s\S]*>离开<\/button>[\s\S]*id="archive-session"[\s\S]*>归档<\/button>[\s\S]*id="restart-session"[\s\S]*>重启<\/button>[\s\S]*id="kill-session"[\s\S]*>结束<\/button>/,
  );
  assert.match(app, /archiveSessionButton\.addEventListener\("click", archiveCurrentSession\)/);
  assert.match(page, /id="session-menu"[\s\S]*<summary[^>]*>···<\/summary>/);
  assert.match(page, /id="mobile-disconnect"[\s\S]*>离开<\/button>/);
  assert.match(page, /id="mobile-archive-session"[\s\S]*>归档<\/button>/);
  assert.match(page, /id="mobile-restart-session"[\s\S]*>重启<\/button>/);
  assert.match(page, /id="mobile-kill-session"[\s\S]*>结束<\/button>/);
  assert.match(styles, /@media \(max-width: 560px\) \{[\s\S]*\.session-controls > button \{[\s\S]*display: none/);
  assert.match(styles, /@media \(max-width: 560px\) \{[\s\S]*\.session-menu \{[\s\S]*display: block/);
  assert.match(app, /const sessionId = String\(activeSessionParams\.sessionId \|\| ""\)\.trim\(\)/);
  assert.match(app, /当前任务会停止，历史记录会移入归档，之后仍可恢复/);
  assert.match(app, /body: JSON\.stringify\(\{ archived: true, endLiveSession: true \}\)/);
  assert.match(
    app,
    /async function archiveCurrentSession\(\)[\s\S]*forgetSessionNavigation\([\s\S]*openNewSessionDraft\(\{[\s\S]*cwd: activeSessionParams\.cwd \|\| "\."/,
  );
  assert.match(app, /setArchiveSessionDisabled\(!activeSessionParams\.sessionId \|\| !canManageSession\)/);
  assert.match(server, /const endLiveSession = archived && Boolean\(req\.body\?\.endLiveSession\)/);
  assert.match(server, /removePersistedWebSessionsForCodexSession\(id\)/);
  assert.match(
    server,
    /if \(endLiveSession\) \{[\s\S]*!session\.exited && session\.sessionId === id[\s\S]*killSessionTerminal\(session\)/,
  );
});
