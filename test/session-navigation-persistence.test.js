import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db4-cdfd-7c10-b477-4859c23313be";

test("the current Session navigation survives an Agent Web restart", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-session-navigation-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    path.join(codexHome, "agent-web-sessions.json"),
    `${JSON.stringify({
      "remembered-session": {
        id: "remembered-session",
        cwd: workspaceRoot,
        command: "codex",
        args: ["app-server"],
        transport: "app-server",
        access: "safe",
        mode: "resume-id",
        sessionId: threadId,
        title: "Remember this Session",
        startedAt: "2026-07-27T08:00:00.000Z",
        lastActivityAt: "2026-07-27T08:10:00.000Z",
        detachedAt: "2026-07-27T08:10:00.000Z",
        released: false,
        turnState: { active: false, requirements: [], queuedTurns: [] },
      },
    }, null, 2)}\n`,
  );

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const environment = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(agentPort),
    CODEX_HOME: codexHome,
    WORKSPACE_ROOT: workspaceRoot,
    AGENT_NATIVE_THREAD_CATALOG: "0",
    AGENT_SHARED_APP_SERVER: "0",
    PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authServer.address().port}`,
  };
  let agent = await startAgent(environment);
  t.after(async () => {
    await stopAgent(agent);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${agentPort}/?preview=1&cwd=.&sessionId=${threadId}&title=${encodeURIComponent("Remember this Session")}&access=safe`,
  );
  await page.locator("#nav-current-session:not([disabled])").waitFor();
  await page.locator("#nav-control-center").click();
  await page.locator("#start-screen:not(.hidden)").waitFor();
  assert.equal(new URL(page.url()).searchParams.has("sessionId"), false);
  assert.equal(await page.locator("#nav-current-session").isEnabled(), true);

  await stopAgent(agent);
  agent = null;
  agent = await startAgent(environment);
  await page.reload();
  await page.locator("#start-screen:not(.hidden)").waitFor();

  const currentNavigation = page.locator("#nav-current-session");
  assert.equal(await currentNavigation.isEnabled(), true);
  assert.equal(await currentNavigation.getAttribute("title"), "回到 Remember this Session");
  await currentNavigation.click();
  await page.waitForURL((url) => url.searchParams.get("sessionId") === threadId);
  assert.equal(new URL(page.url()).searchParams.get("preview"), "1");
  await page.locator("#connection").waitFor();
  assert.match(await page.locator("#connection").innerText(), /仅查看/);
});

async function startAgent(environment) {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await waitFor(() => output.includes("Agent Terminal Web:"), 5_000);
  return child;
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}

async function reservePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for isolated Agent Web");
}
