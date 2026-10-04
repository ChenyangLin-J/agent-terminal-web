import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hashSessionShareToken,
  renderSessionSharePage,
  SessionShareStore,
} from "../lib/session-shares.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Session share tokens are hashed, replaceable, revocable, and expire after 24 hours", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-shares-"));
  const file = path.join(root, "session-shares.json");
  const start = Date.parse("2026-07-27T04:00:00.000Z");
  let now = start;
  const store = new SessionShareStore(file, { now: () => now });
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await store.create({
    hostId: "personal",
    sessionId: "019f9db4-cdfd-7c10-b477-4859c23313be",
    title: "临时分享",
    messages: [
      { role: "user", text: "帮我看看" },
      { role: "assistant", text: "已经看完。" },
    ],
  });
  const stored = await readFile(file, "utf8");
  assert.doesNotMatch(stored, new RegExp(first.token));
  assert.match(stored, new RegExp(hashSessionShareToken(first.token)));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(Date.parse(first.share.expiresAt) - Date.parse(first.share.createdAt), 24 * 60 * 60 * 1000);
  assert.deepEqual((await store.resolve(first.token))?.messages, [
    { role: "user", text: "帮我看看" },
    { role: "assistant", text: "已经看完。" },
  ]);

  const second = await store.create({
    hostId: "personal",
    sessionId: "019f9db4-cdfd-7c10-b477-4859c23313be",
    title: "新快照",
    messages: [{ role: "assistant", text: "替换后的内容" }],
  });
  assert.equal(await store.resolve(first.token), null);
  assert.equal((await store.list({
    hostId: "personal",
    sessionId: "019f9db4-cdfd-7c10-b477-4859c23313be",
  })).length, 1);
  assert.equal(await store.revoke(second.share.id), true);
  assert.equal(await store.resolve(second.token), null);

  const expiring = await store.create({
    hostId: "personal",
    sessionId: "019f9db5-cdfd-7c10-b477-4859c23313be",
    title: "会过期",
    messages: [{ role: "user", text: "一天后见" }],
  });
  now += 24 * 60 * 60 * 1000 + 1;
  assert.equal(await store.resolve(expiring.token), null);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")).shares, []);
});

test("the public snapshot renders safe text without local links, scripts, or remote images", () => {
  const page = renderSessionSharePage({
    title: '<script>alert("title")</script>',
    createdAt: "2026-07-27T04:00:00.000Z",
    expiresAt: "2026-07-28T04:00:00.000Z",
    messages: [
      {
        role: "user",
        text: '<script>alert("message")</script>\n[本地文件](/home/ubuntu/workspace/private.md:12)',
      },
      {
        role: "assistant",
        text: "[公开来源](https://example.com/source)\n![跟踪图](https://example.com/tracker.png)",
      },
    ],
  });

  assert.doesNotMatch(page, /<script>/);
  assert.doesNotMatch(page, /\/home\/ubuntu\/workspace\/private\.md/);
  assert.match(page, /本地文件/);
  assert.match(page, /href="https:\/\/example\.com\/source"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.doesNotMatch(page, /<img/);
  assert.match(page, /跟踪图/);
});

test("the share page is public while authenticated Agent APIs remain protected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-session-share-route-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const sharesFile = path.join(root, "state", "session-shares.json");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(codexHome, { recursive: true }),
  ]);
  const store = new SessionShareStore(sharesFile);
  const created = await store.create({
    hostId: "personal",
    sessionId: "019f9db4-cdfd-7c10-b477-4859c23313be",
    title: "公开只读快照",
    messages: [{ role: "assistant", text: "这是静态内容。" }],
  });

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":false}');
  });
  const authPort = await listen(authServer);
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
      AGENT_SESSION_SHARES_FILE: sharesFile,
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
    await rm(root, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 3000);

  const shared = await fetch(`http://127.0.0.1:${agentPort}/share/${created.token}`);
  const page = await shared.text();
  assert.equal(shared.status, 200);
  assert.match(shared.headers.get("cache-control"), /no-store/);
  assert.match(shared.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(shared.headers.get("referrer-policy"), "no-referrer");
  assert.match(page, /公开只读快照/);
  assert.match(page, /这是静态内容/);

  const privateApi = await fetch(`http://127.0.0.1:${agentPort}/api/sessions`);
  assert.equal(privateApi.status, 401);

  await store.revoke(created.share.id);
  const revoked = await fetch(`http://127.0.0.1:${agentPort}/share/${created.token}`);
  assert.equal(revoked.status, 410);
  assert.match(await revoked.text(), /这个分享链接已失效/);
});

test("the Agent UI exposes explicit create, copy, and revoke controls", async () => {
  const server = await readFile(path.join(projectRoot, "server.js"), "utf8");
  assert.match(server, /app\.get\("\/share\/:token"/);
  assert.match(server, /app\.post\("\/api\/session-shares"/);
  assert.match(server, /app\.delete\("\/api\/session-shares\/:id"/);
  assert.match(server, /sessionShareSnapshotFromStoredThread\(sessionId\)/);
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
