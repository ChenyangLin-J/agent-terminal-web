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
const companyThreadId = "11111111-1111-4111-8111-111111111111";

test("opening a company Session previews remote turns without creating a runtime", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-remote-session-preview-"));
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
  let previewRequests = 0;
  let webSocketsOpened = 0;
  page.on("websocket", () => {
    webSocketsOpened += 1;
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("host") !== "company") {
      await route.continue();
      return;
    }
    if (url.pathname === "/api/sessions") {
      await fulfillJson(route, { host: { id: "company", label: "公司" }, sessions: [] });
      return;
    }
    if (url.pathname === "/api/codex-sessions") {
      await fulfillJson(route, {
        host: { id: "company", label: "公司" },
        sessions: [
          {
            id: companyThreadId,
            title: "公司只读 Session",
            project: "company-project",
            updatedAt: "2026-07-28T08:00:00.000Z",
            access: "safe",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/codex-sessions/archived") {
      await fulfillJson(route, { host: { id: "company", label: "公司" }, sessions: [] });
      return;
    }
    if (url.pathname === `/api/session-preview/${companyThreadId}`) {
      previewRequests += 1;
      await fulfillJson(route, {
        preview: {
          prompt: "检查公司项目",
          result: "公司记录已加载",
          completedAt: "2026-07-28T08:01:00.000Z",
        },
        conversation: {
          turns: [
            {
              id: "turn-1",
              user: "检查公司项目",
              assistant: [
                {
                  text: "公司记录已加载",
                  phase: "final_answer",
                  completedAt: "2026-07-28T08:01:00.000Z",
                },
              ],
              startedAt: "2026-07-28T08:00:00.000Z",
            },
          ],
          hasEarlier: false,
        },
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`http://127.0.0.1:${agentPort}/`);
  const savedSessions = page.locator("#codex-sessions-list");
  await savedSessions.getByText("公司只读 Session", { exact: true }).waitFor();
  await savedSessions.locator(".session-card-primary[aria-label='打开 公司只读 Session']").click();

  await page.locator("#app-server-transcript").getByText("公司记录已加载", { exact: true }).waitFor();
  const currentUrl = new URL(page.url());
  assert.equal(currentUrl.searchParams.get("host"), "company");
  assert.equal(currentUrl.searchParams.get("preview"), "1");
  assert.equal(currentUrl.searchParams.get("sessionId"), companyThreadId);
  assert.equal(previewRequests, 1);
  assert.equal(webSocketsOpened, 0);
  assert.match(await page.locator("#connection").innerText(), /仅查看/);
});

async function fulfillJson(route, body) {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
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
