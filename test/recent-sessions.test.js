import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("recent sessions expose resumable links to local Home callers", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-recent-sessions-"));
  const codexHome = path.join(temporaryRoot, "codex");
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const projectRoot = path.join(workspaceRoot, "personal-site");
  const sessionId = "01900000-0000-7000-8000-000000000001";
  const generatedSessionId = "01900000-0000-7000-8000-000000000002";
  const liveSessionId = "01900000-0000-7000-8000-000000000003";
  const recentDetachedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const expiredDetachedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const sessionFile = path.join(codexHome, "sessions", "2026", "07", "15", `rollout-${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({ payload: { id: sessionId, cwd: projectRoot, timestamp: "2026-07-15T08:00:00.000Z" } })}\n`,
  );
  for (const [id, prompt] of [
    [generatedSessionId, "$thinking-partner 讨论一下自动标题"],
    [liveSessionId, "JSONL 中的旧标题"],
  ]) {
    const file = path.join(codexHome, "sessions", "2026", "07", "15", `rollout-${id}.jsonl`);
    const runtimeContexts = [
      "# AGENTS.md instructions injected context",
      "<environment_context> injected context",
      "<permissions instructions> injected context",
      "<skills_instructions> injected context",
      "<multi_agent_mode> injected context",
      "<apps_instructions> injected context",
      "<plugins_instructions> injected context",
      "<recommended_plugins> injected runtime context",
      "<collaboration_mode> injected context",
      "<personal-memory> injected context",
      "<skill> injected context",
      "You are Codex, injected context",
    ];
    await fs.writeFile(
      file,
      [
        JSON.stringify({ payload: { id, cwd: projectRoot, timestamp: "2026-07-15T08:00:00.000Z" } }),
        ...runtimeContexts.map((text) =>
          JSON.stringify({
            type: "response_item",
            payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
          }),
        ),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] },
        }),
      ].join("\n") + "\n",
    );
  }
  await fs.writeFile(path.join(codexHome, "session-titles.json"), `${JSON.stringify({ [sessionId]: "个人网站调整" })}\n`);
  await fs.writeFile(
    path.join(codexHome, "agent-web-sessions.json"),
    `${JSON.stringify({
      "web-session-live-title": {
        id: "web-session-live-title",
        cwd: projectRoot,
        transport: "app-server",
        access: "full",
        sessionId: liveSessionId,
        title: "Agent 当前展示标题",
        lastActivityAt: recentDetachedAt,
        detachedAt: recentDetachedAt,
        turnState: { active: false },
      },
      "web-session-expired": {
        id: "web-session-expired",
        cwd: projectRoot,
        transport: "app-server",
        access: "full",
        sessionId: generatedSessionId,
        title: "过期的 Live Session",
        lastActivityAt: expiredDetachedAt,
        detachedAt: expiredDetachedAt,
        turnState: { active: false },
      },
    })}\n`,
  );
  await fs.writeFile(
    path.join(codexHome, "agent-session-previews.json"),
    `${JSON.stringify({
      [sessionId]: {
        sessionId,
        prompt: "调整个人网站",
        result: "个人网站已经调整完成。",
        completedAt: "2026-07-15T09:00:00.000Z",
      },
    })}\n`,
  );

  const port = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      PRIVATE_AUTH_VERIFY_URL: "http://127.0.0.1:1/api/verify",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });

  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);
  const response = await fetch(`http://127.0.0.1:${port}/internal/recent-sessions`);
  assert.equal(response.status, 200);
  const data = await response.json();

  assert.equal(data.sessions.length, 3);
  const custom = data.sessions.find((session) => session.id === sessionId);
  const generated = data.sessions.find((session) => session.id === generatedSessionId);
  const live = data.sessions.find((session) => session.id === liveSessionId);
  assert.equal(custom.title, "个人网站调整");
  assert.equal(custom.project, "personal-site");
  assert.equal(custom.current, false);
  assert.equal(custom.live, false);
  assert.equal(custom.webSessionId, "");
  assert.equal(custom.lastResult, "个人网站已经调整完成。");
  assert.equal(custom.lastCompletedAt, "2026-07-15T09:00:00.000Z");
  assert.equal(generated.title, "过期的 Live Session");
  assert.equal(generated.current, true);
  assert.equal(generated.live, false);
  assert.equal(generated.released, true);
  assert.equal(generated.webSessionId, "web-session-expired");
  assert.equal(live.title, "Agent 当前展示标题");
  assert.equal(live.current, true);
  assert.equal(live.live, false);
  assert.equal(live.released, true);
  assert.equal(live.webSessionId, "web-session-live-title");
  assert.match(output, /Detached session TTL: 30 minutes/);

  const persistedSessions = JSON.parse(await fs.readFile(path.join(codexHome, "agent-web-sessions.json"), "utf8"));
  assert.equal(persistedSessions["web-session-expired"].released, true);

  const proxiedResponse = await fetch(`http://127.0.0.1:${port}/internal/recent-sessions`, {
    headers: { "x-forwarded-for": "127.0.0.1" },
  });
  assert.equal(proxiedResponse.status, 404);
});

async function reservePort() {
  const net = await import("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent server startup");
}
