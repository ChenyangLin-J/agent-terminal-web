import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildAppServerTurnAdditionalContext } from "../lib/app-server-turn-context.js";

test("Auto orchestration persists per Session and applies a token-conscious role policy", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /const AUTO_ORCHESTRATION_ROLE_DEFAULTS = \[/);
  assert.match(server, /name: "explorer"[\s\S]*model: "gpt-5\.6-terra"[\s\S]*reasoningEffort: "medium"/);
  assert.match(server, /name: "worker"[\s\S]*model: "gpt-5\.6-sol"[\s\S]*reasoningEffort: "high"/);
  assert.match(server, /name: "reviewer"[\s\S]*model: "gpt-5\.6-sol"[\s\S]*reasoningEffort: "high"/);
  assert.match(server, /function normalizeOrchestrationMode\(value\)/);
  assert.match(server, /orchestrationMode: normalizeOrchestrationMode\(restored\.orchestrationMode\)/);
  assert.match(server, /orchestrationMode: normalizeOrchestrationMode\(session\.orchestrationMode\)/);
  assert.match(server, /message\.type === "set-orchestration-mode"/);
  assert.match(server, /function appServerTurnAdditionalContext\(session, personalMemoryContext\)/);
  assert.match(server, /Auto mode is the user's standing authorization/);
  assert.match(
    server,
    /additionalContext: appServerTurnAdditionalContext\(session, personalMemory\.additionalContext\)/,
  );

  assert.match(page, /id="orchestration-mode-auto"[\s\S]*aria-pressed="true"/);
  assert.match(page, /id="orchestration-role-summary"/);
  assert.match(app, /function updateOrchestrationMode\(mode\)/);
  assert.match(app, /function syncOrchestrationMode\(\)/);
  assert.match(app, /activeOrchestrationMode = status\.orchestrationMode === "manual" \? "manual" : "auto"/);
  assert.match(styles, /\.orchestration-panel/);
});

test("live context usage reaches the toolbar and warns at 100k and 150k", async () => {
  const [server, app, page, styles] = await Promise.all([
    readFile(new URL("../server.js", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(server, /function publicAppTokenUsage\(usage, fallbackContextWindow = 0\)/);
  assert.match(server, /contextUsedTokens >= 150_000[\s\S]*contextUsedTokens >= 100_000/);
  assert.match(
    server,
    /method === "thread\/tokenUsage\/updated"[\s\S]*broadcast\(session, "status", publicSession\(session\)\)/,
  );
  assert.match(server, /tokenUsage:[\s\S]*publicAppTokenUsage\(session\.appTokenUsage\)/);

  assert.match(page, /id="app-session-context"[\s\S]*data-context-state="unknown"/);
  assert.match(app, /function syncContextUsage\(\)/);
  assert.match(app, /function maybeNotifyContextAlert\(status\)/);
  assert.match(app, /建议完成当前阶段后 \/compact 或新建 Session/);
  assert.match(styles, /button\[data-context-state="watch"\]/);
  assert.match(styles, /button\[data-context-state="critical"\]/);
});

test("turn additional context remains an App Server map when orchestration mode is added", () => {
  const personalMemoryContext = {
    "personal-memory": {
      kind: "application",
      value: "Remember the current project.",
    },
  };

  const context = buildAppServerTurnAdditionalContext("auto", personalMemoryContext);

  assert.notEqual(context, personalMemoryContext);
  assert.deepEqual(context["personal-memory"], personalMemoryContext["personal-memory"]);
  assert.deepEqual(context["multi-agent-mode"], {
    kind: "application",
    value:
      '<multi_agent_mode mode="auto">The user enabled Auto orchestration for this Session. Apply the Agent Web multi-agent policy and delegate only when it is a net benefit.</multi_agent_mode>',
  });
  assert.equal(typeof context, "object");
  assert.equal(Array.isArray(context), false);
});

test("turn additional context uses a map without personal memory and supports manual mode", () => {
  const context = buildAppServerTurnAdditionalContext("manual", undefined);

  assert.deepEqual(context, {
    "multi-agent-mode": {
      kind: "application",
      value:
        '<multi_agent_mode mode="manual">Do not spawn sub-agents unless the user explicitly requests delegation in this task.</multi_agent_mode>',
    },
  });
});
