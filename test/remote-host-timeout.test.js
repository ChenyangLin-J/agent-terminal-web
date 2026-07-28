import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a slow remote Host keeps its last Sessions and recovers in the background", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-remote-host-timeout-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const hostsFile = path.join(root, "hosts.json");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
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
            projects: ["company-project"],
          },
        ],
      }),
    ),
  ]);
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

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  let slowCompanySessions = true;
  let companySessionTitle = "公司旧数据";
  let companyLiveRequests = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("host") !== "company") {
      await route.continue();
      return;
    }
    if (url.pathname === "/api/sessions") {
      companyLiveRequests += 1;
      const title = companySessionTitle;
      if (slowCompanySessions) {
        await new Promise((resolve) => setTimeout(resolve, 7_000));
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          host: { id: "company", label: "公司" },
          sessions: [
            {
              id: "company-live",
              sessionId: "11111111-1111-4111-8111-111111111111",
              title,
              cwd: "/Users/mac/Documents/workspace/company-project",
              startedAt: "2026-07-28T01:00:00.000Z",
              lastActivityAt: "2026-07-28T01:05:00.000Z",
              connectedClients: 0,
              turnState: { active: false, requirements: [] },
            },
          ],
        }),
      });
      return;
    }
    if (
      url.pathname === "/api/codex-sessions"
      || url.pathname === "/api/codex-sessions/archived"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          host: { id: "company", label: "公司" },
          sessions: [],
        }),
      });
      return;
    }
    await route.continue();
  });

  const initialLoadStartedAt = Date.now();
  await page.goto(`http://127.0.0.1:${agentPort}/`);
  const controlCenterSessions = page.locator("#sessions-list");
  await controlCenterSessions.getByText("公司旧数据", { exact: true }).waitFor();
  const initialLoadElapsedMs = Date.now() - initialLoadStartedAt;
  assert.ok(initialLoadElapsedMs >= 6_500, `cold remote request ended too soon after ${initialLoadElapsedMs}ms`);
  assert.ok(initialLoadElapsedMs < 11_500, `cold remote request blocked the UI for ${initialLoadElapsedMs}ms`);

  const startedAt = Date.now();
  await page.evaluate(() => loadLiveSessions());
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs >= 4_500, `remote request ended too soon after ${elapsedMs}ms`);
  assert.ok(elapsedMs < 6_500, `remote request blocked the UI for ${elapsedMs}ms`);
  assert.equal(await controlCenterSessions.getByText("公司旧数据", { exact: true }).count(), 1);

  slowCompanySessions = false;
  companySessionTitle = "公司后台已恢复";
  await controlCenterSessions.getByText("公司后台已恢复", { exact: true }).waitFor({ timeout: 20_000 });
  assert.ok(companyLiveRequests >= 3);
  assert.equal(await controlCenterSessions.getByText("公司旧数据", { exact: true }).count(), 0);
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
  throw new Error("Timed out waiting for Agent server");
}
