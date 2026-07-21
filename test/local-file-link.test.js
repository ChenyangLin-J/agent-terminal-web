import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gardenLinkForLocalMarkdown } from "../lib/local-file-link.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("local Obsidian Markdown paths resolve to Garden URLs", () => {
  const vaultRoot = "/home/ubuntu/workspace/obsidian/MainVault";
  const options = { vaultRoot, gardenBaseUrl: "https://garden.chenyanglin.com" };

  assert.equal(
    gardenLinkForLocalMarkdown(`${vaultRoot}/Work/Tasks.md`, options)?.href,
    "https://garden.chenyanglin.com/work/tasks",
  );
  assert.equal(
    gardenLinkForLocalMarkdown(`${vaultRoot}/Life/职业思考.md`, options)?.href,
    "https://garden.chenyanglin.com/life/%E8%81%8C%E4%B8%9A%E6%80%9D%E8%80%83",
  );
  assert.equal(gardenLinkForLocalMarkdown(`${vaultRoot}/Work/index.md`, options)?.href, "https://garden.chenyanglin.com/work");
  assert.equal(gardenLinkForLocalMarkdown("/home/ubuntu/workspace/personal-site/README.md", options), null);
  assert.equal(gardenLinkForLocalMarkdown(`${vaultRoot}/Work/Tasks.pdf`, options), null);
});

test("the authenticated local-link route redirects only existing Vault notes", async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-local-link-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const vaultRoot = path.join(workspaceRoot, "obsidian", "MainVault");
  const taskFile = path.join(vaultRoot, "Work", "Tasks.md");
  await fs.mkdir(path.dirname(taskFile), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(taskFile, "# Tasks\n");

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  const authPort = await listen(authServer);
  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    authServer.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);

  const redirect = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent(taskFile)}`,
    { redirect: "manual" },
  );
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), "https://garden.chenyanglin.com/work/tasks");

  const rejected = await fetch(
    `http://127.0.0.1:${agentPort}/open/local?path=${encodeURIComponent("/etc/passwd")}`,
    { redirect: "manual" },
  );
  assert.equal(rejected.status, 404);
});

async function reservePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Agent server startup");
}
