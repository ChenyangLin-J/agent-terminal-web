import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guardUrl = new URL("../scripts/codex-guard-bin/systemctl", import.meta.url);

test("web Codex processes receive restart safety instructions and a guarded PATH", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /const CODEX_GUARD_BIN = path\.join\(__dirname, "scripts", "codex-guard-bin"\)/);
  assert.match(server, /PATH: \[CODEX_GUARD_BIN, process\.env\.PATH\]/);
  assert.match(server, /env: codexEnvironmentForWeb\(`shared-\$\{agentInstanceId\}`\)/);
  assert.match(server, /AGENT_WEB_SESSION_ID: sessionId/);
  assert.match(server, /AGENT_WEB_PROTECTED_SERVICE: "agent-terminal-web\.service"/);
  assert.match(server, /developerInstructions: AGENT_WEB_DEVELOPER_INSTRUCTIONS/);
  assert.match(server, /Never stop, restart, kill, or otherwise terminate agent-terminal-web\.service/);
});

test("systemctl guard blocks destructive Agent Web service actions", async () => {
  const guard = guardUrl.pathname;
  const mode = (await stat(guard)).mode;
  assert.ok(mode & 0o100, "systemctl guard must be executable");

  for (const args of [
    ["--user", "restart", "agent-terminal-web.service"],
    ["stop", "agent-terminal-web"],
    ["--user", "kill", "home-portal.service", "agent-terminal-web.service"],
  ]) {
    const result = spawnSync(guard, args, { encoding: "utf8" });
    assert.equal(result.status, 64);
    assert.match(result.stderr, /Blocked by Agent Web/);
    assert.match(result.stderr, /external Agent Web restart/);
  }
});

test("interrupted App Server turns remain visible and can be continued", async () => {
  const [server, app, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /interruptedTurnStateAfterProcessLoss\(record\.turnState, record\.lastActivityAt\)/);
  assert.match(server, /state\.turnId !== state\.lastCompletedTurnId/);
  assert.match(server, /requirement\.status === "working"\) requirement\.status = "interrupted"/);
  assert.match(server, /message\.type === "resume-interrupted"/);
  assert.match(server, /session\.interruptedResumePending = true/);
  assert.match(server, /session\.interruptedResumePending = false/);
  assert.match(server, /function interruptedContinuationPrompt\(state\)/);
  assert.match(server, /不要停止或重启 agent-terminal-web\.service/);
  assert.match(app, /function createInterruptedTurnNotice\(\)/);
  assert.match(app, /action\.textContent = resumeInterruptedPending \? "正在继续…" : "继续完成"/);
  assert.match(app, /send\(\{ type: "resume-interrupted" \}\)/);
  assert.match(app, /isInterruptedTurn \? "中断" : isStoppedTurn \? "已终止" : "完成"/);
  assert.match(styles, /\.app-interrupted-turn/);
  assert.match(styles, /\.app-process-group\.is-interrupted/);
});
