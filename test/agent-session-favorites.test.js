import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  readAgentSessionFavorites,
  setAgentSessionFavorite,
} from "../lib/agent-session-favorites.js";

const firstSessionId = "019f9db4-cdfd-7c10-b477-4859c23313be";
const secondSessionId = "019f9db5-cdfd-7c10-b477-4859c23313be";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Agent and Home can share a normalized Session favorites file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-favorites-"));
  const filePath = path.join(root, "agent-session-favorites.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(filePath, JSON.stringify([firstSessionId, "", firstSessionId, "invalid"]));
  assert.deepEqual(readAgentSessionFavorites(filePath), [firstSessionId]);

  assert.deepEqual(setAgentSessionFavorite(filePath, secondSessionId, true), [
    firstSessionId,
    secondSessionId,
  ]);
  assert.deepEqual(setAgentSessionFavorite(filePath, firstSessionId, false), [secondSessionId]);
  assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), [secondSessionId]);
});

test("Agent Session favorites reject invalid IDs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-favorites-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => setAgentSessionFavorite(path.join(root, "favorites.json"), "../escape", true),
    /Session ID 不合法/,
  );
});

test("damaged favorites block mutation without replacing the source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-favorites-corrupt-"));
  const filePath = path.join(root, "favorites.json");
  const damaged = "{ not valid JSON\n";
  await writeFile(filePath, damaged);
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.throws(
    () => setAgentSessionFavorite(filePath, firstSessionId, true),
    /Agent Session favorites parse failed/,
  );
  assert.equal(await readFile(filePath, "utf8"), damaged);
});

test("the authenticated Agent API updates the shared favorites file", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-favorites-api-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const favoritesFile = path.join(root, "home", "agent-session-favorites.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
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
      AGENT_NATIVE_THREAD_CATALOG: "0",
      AGENT_SESSION_FAVORITES_FILE: favoritesFile,
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
  try {
    await waitFor(() => output.includes("Agent Terminal Web:"), 3000);
  } catch {
    assert.fail(`Agent test server did not start:\n${output}`);
  }

  const response = await fetch(
    `http://127.0.0.1:${agentPort}/api/codex-sessions/${firstSessionId}/favorite`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorited: true }),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: firstSessionId, favorited: true });
  assert.deepEqual(JSON.parse(await readFile(favoritesFile, "utf8")), [firstSessionId]);
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
  throw new Error("Timed out waiting for condition");
}
