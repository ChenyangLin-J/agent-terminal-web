import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("App Server exposes slash commands and structured Skill mentions", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

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
  assert.match(server, /message\.type === "interrupt-turn"/);
  assert.match(server, /session\.appServer[\s\S]*\.interruptTurn\(\)/);
  assert.match(server, /if \(!stopped\) persistCompletedSessionPreview/);
  assert.match(server, /if \(!stopped\) \{[\s\S]*personalMemoryScheduler\.schedule\([^)]*\);[\s\S]*void sendAppServerTurnNotification/);
  assert.match(server, /type: "skill", name: skill\.name, path: skill\.path/);
  assert.match(server, /\.\.\.appServerTurnAccess\(session\)/);
  assert.match(server, /\? \{ type: "dangerFullAccess" \}/);
  assert.match(server, /: \{ type: "workspaceWrite", writableRoots: \[session\.cwd\], networkAccess: false \}/);
  assert.match(server, /const submission = await submitAppServerPrompt\([\s\S]*prompt\.attachments,[\s\S]*prompt\.requirementText/);
  assert.doesNotMatch(server, /Slash commands are not available in App Server experiment mode/);


  assert.match(server, /interruptTurn: true/);

});
