import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Agent API exposes host-scoped projects and live sessions without contacting an offline Mac", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-host-api-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const hostsFile = path.join(root, "hosts.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(workspaceRoot, "personal-site"), { recursive: true }),
    mkdir(codexHome, { recursive: true }),
    writeFile(
      hostsFile,
      JSON.stringify({
        hosts: [
          {
            id: "company",
            label: "公司",
            type: "ssh",
            sshHost: "company-mac",
            workspaceRoot: "/Users/mac/Documents/workspace",
            codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
            projects: ["solvely"],
          },
        ],
      }),
    ),
  ]);

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
      AGENT_HOSTS_FILE: hostsFile,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGTERM");
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3_000);

  const hosts = await json(agentPort, "/api/hosts");
  assert.deepEqual(hosts.hosts.map((host) => host.id), ["personal", "company"]);

  const personalProjects = await json(agentPort, "/api/projects?host=personal");
  assert.deepEqual(personalProjects.projects, ["personal-site"]);

  const companyProjects = await json(agentPort, "/api/projects?host=company");
  assert.equal(companyProjects.workspaceRoot, "/Users/mac/Documents/workspace");
  assert.deepEqual(companyProjects.projects, ["solvely"]);

  const companySessions = await json(agentPort, "/api/sessions?host=company");
  assert.equal(companySessions.host.id, "company");
  assert.deepEqual(companySessions.sessions, []);

  const sessionId = "11111111-1111-4111-8111-111111111111";
  const turnId = "22222222-2222-4222-8222-222222222222";
  await json(agentPort, `/api/codex-sessions/${sessionId}/favorite?host=personal`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ favorited: true }),
  });
  await json(agentPort, `/api/codex-sessions/${sessionId}/favorite?host=company`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ favorited: true }),
  });
  await json(agentPort, `/api/codex-sessions/${sessionId}/viewed?host=personal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId }),
  });
  await json(agentPort, `/api/codex-sessions/${sessionId}/viewed?host=company`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ turnId }),
  });

  const personalFavorites = JSON.parse(
    await readFile(path.join(root, ".local", "share", "home-portal", "agent-session-favorites.json"), "utf8"),
  );
  const companyFavorites = JSON.parse(
    await readFile(path.join(root, "host-state", "company-favorites.json"), "utf8"),
  );
  assert.deepEqual(personalFavorites, [sessionId]);
  assert.deepEqual(companyFavorites, [sessionId]);

  const settings = JSON.parse(
    await readFile(path.join(codexHome, "agent-session-settings.json"), "utf8"),
  );
  assert.ok(settings[sessionId]);
  assert.ok(settings[`company:${sessionId}`]);
});

async function json(port, pathname, options = undefined) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, options);
  const body = await response.text();
  assert.equal(response.status, 200, body);
  return JSON.parse(body);
}

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
  throw new Error("Timed out waiting for Agent server");
}
