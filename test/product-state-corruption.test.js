import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionId = "019f9db4-cdfd-7c10-b477-4859c23313be";

test("corrupt product state returns errors and no mutation route replaces its source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-product-state-api-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const damaged = "{ damaged product state\n";
  const files = {
    sessions: path.join(codexHome, "agent-web-sessions.json"),
    settings: path.join(codexHome, "agent-session-settings.json"),
    titles: path.join(codexHome, "session-titles.json"),
    archive: path.join(codexHome, "session-archive.json"),
  };
  await Promise.all([mkdir(workspaceRoot, { recursive: true }), mkdir(codexHome, { recursive: true })]);
  await Promise.all(Object.values(files).map((file) => writeFile(file, damaged)));
  t.after(() => rm(root, { recursive: true, force: true }));

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  const authPort = await listen(authServer);
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3_000);

  const requests = [
    fetch(`http://127.0.0.1:${agentPort}/api/sessions`),
    fetch(`http://127.0.0.1:${agentPort}/api/codex-sessions/${sessionId}/viewed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: sessionId }),
    }),
    fetch(`http://127.0.0.1:${agentPort}/api/codex-sessions/${sessionId}/title`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Replacement" }),
    }),
    fetch(`http://127.0.0.1:${agentPort}/api/codex-sessions/${sessionId}/archive`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ archived: true }),
    }),
  ];
  const responses = await Promise.all(requests);
  assert.deepEqual(responses.map((response) => response.status), [500, 500, 500, 500], output);
  for (const file of Object.values(files)) {
    assert.equal(await readFile(file, "utf8"), damaged);
  }
});

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
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
