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
  const sessionFile = path.join(codexHome, "sessions", "2026", "07", "15", `rollout-${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(
    sessionFile,
    `${JSON.stringify({ payload: { id: sessionId, cwd: projectRoot, timestamp: "2026-07-15T08:00:00.000Z" } })}\n`,
  );
  await fs.writeFile(path.join(codexHome, "session-titles.json"), `${JSON.stringify({ [sessionId]: "个人网站调整" })}\n`);

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

  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].title, "个人网站调整");
  assert.equal(data.sessions[0].project, "personal-site");
  assert.equal(data.sessions[0].live, false);
  assert.equal(data.sessions[0].id, sessionId);
  assert.equal(data.sessions[0].webSessionId, "");

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
