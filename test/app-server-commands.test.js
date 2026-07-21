import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server exposes slash commands and structured Skill mentions", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /async function handleAppServerCommand\(session, ws, value\)/);
  assert.match(server, /session\.appServer\.readThread/);
  assert.match(server, /session\.appServer\.readConfig/);
  assert.match(server, /session\.appServer\.readRateLimits/);
  assert.match(server, /session\.appServer\.readAccountUsage/);
  assert.match(server, /async function appServerModels\(session, argument\)/);
  assert.match(server, /async function appServerMcpInventory\(session\)/);
  assert.match(server, /async function appServerPluginInventory\(session\)/);
  assert.match(server, /async function appServerHookInventory\(session\)/);
  assert.match(server, /message\.type === "skills-list"/);
  assert.match(server, /message\.type === "set-access"/);
  assert.match(server, /type: "skill", name: skill\.name, path: skill\.path/);
  assert.match(server, /\.\.\.appServerTurnAccess\(session\)/);
  assert.match(server, /\? \{ type: "dangerFullAccess" \}/);
  assert.match(server, /: \{ type: "workspaceWrite", writableRoots: \[session\.cwd\], networkAccess: false \}/);
  assert.match(server, /const submission = await submitAppServerPrompt\(session, prompt\.text, prompt\.deliveryMode, prompt\.skillNames\)/);
  assert.doesNotMatch(server, /Slash commands are not available in App Server experiment mode/);

  assert.match(page, /id="composer-suggestions"/);
  assert.match(page, /id="app-command-dialog"/);
  assert.match(page, /id="app-session-tools"/);
  assert.match(page, /id="app-session-permissions"/);
  assert.match(app, /const APP_COMMANDS = \[/);
  for (const command of [
    "/status",
    "/usage",
    "/permissions",
    "/model",
    "/fast",
    "/skills",
    "/goal",
    "/rename",
    "/compact",
    "/copy",
    "/memories",
    "/diff",
    "/review",
    "/mcp",
    "/plugins",
    "/hooks",
  ]) {
    assert.match(app, new RegExp(`name: "${command.replace("/", "\\/")}"`));
  }
  assert.match(app, /function updateComposerSuggestions\(\)/);
  assert.match(app, /function receiveAppSkills\(payload = \{\}\)/);
  assert.match(app, /function renderAppCommandResult\(payload = \{\}\)/);
  assert.match(app, /function syncAppSessionToolbar\(\)/);
  assert.match(app, /appSessionPermissionsButton\.addEventListener\("click", \(\) => runAppCommand\("\/permissions"\)\)/);
  assert.match(app, /skills: activeTransport === "app-server" \? extractSkillMentions\(prompt\) : \[\]/);
  assert.match(styles, /\.composer-suggestions/);
  assert.match(styles, /\.app-command-dialog/);
  assert.match(styles, /\.app-command-meters/);
  assert.match(styles, /\.app-server-session \.app-session-tools/);
});

test("process output details are collapsed by default", async () => {
  const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /createTranscriptDetails\(`查看输出 · \$\{lines\} 行`, item\.output, false\)/);
  assert.doesNotMatch(app, /const shouldOpen = .*item\.output/);
});
