import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  normalizeRemoteTurnCompletion,
  readRemoteNotificationTokens,
  resolveRemoteNotificationHost,
} from "../lib/remote-agent-notification.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteNotifyScript = path.join(projectRoot, "scripts", "remote-codex-notify.py");
const threadId = "11111111-1111-4111-8111-111111111111";
const token = "company-notify-token-".padEnd(64, "x");

test("remote completion tokens are host-scoped and timing-safe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-remote-notify-token-"));
  const tokensFile = path.join(root, "tokens.json");
  await writeFile(tokensFile, JSON.stringify({ company: token }));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hosts = [
    { id: "personal", type: "local" },
    { id: "company", type: "ssh" },
  ];

  assert.equal(readRemoteNotificationTokens(tokensFile).get("company"), token);
  assert.equal(
    resolveRemoteNotificationHost({
      authorization: `Bearer ${token}`,
      hosts,
      tokensFile,
    })?.id,
    "company",
  );
  assert.equal(
    resolveRemoteNotificationHost({
      authorization: `Bearer ${"wrong".padEnd(64, "x")}`,
      hosts,
      tokensFile,
    }),
    null,
  );
  assert.equal(normalizeRemoteTurnCompletion({ type: "turn/completed" }), null);
  assert.deepEqual(
    normalizeRemoteTurnCompletion({
      type: "agent-turn-complete",
      "thread-id": threadId,
      "turn-id": "turn-company-1",
      "completed-at": "2026-07-28T10:00:00.000Z",
      "last-assistant-message": "公司任务完成",
    }),
    {
      threadId,
      turnId: "turn-company-1",
      completedAt: "2026-07-28T10:00:00.000Z",
      lastAssistantMessage: "公司任务完成",
    },
  );
});

test("authenticated company completion marks a new result and pushes once without resuming", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-remote-notify-api-"));
  const workspaceRoot = path.join(root, "workspace");
  const codexHome = path.join(root, "codex");
  const hostsFile = path.join(root, "hosts.json");
  const tokensFile = path.join(root, "tokens.json");
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
            sshHost: "unreachable-company",
            workspaceRoot: "/Users/mac/Documents/workspace",
            codexCommand: "/Applications/ChatGPT.app/Contents/Resources/codex",
          },
        ],
      }),
    ),
    writeFile(tokensFile, JSON.stringify({ company: token })),
  ]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const deliveries = [];
  const pushServer = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      deliveries.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"sent":1,"subscriptionCount":1}');
    });
  });
  const pushPort = await listen(pushServer);
  t.after(() => pushServer.close());

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
      AGENT_REMOTE_NOTIFY_TOKENS_FILE: tokensFile,
      HOME_PUSH_URL: `http://127.0.0.1:${pushPort}`,
      AGENT_NATIVE_THREAD_CATALOG: "0",
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

  const event = {
    type: "agent-turn-complete",
    "thread-id": threadId,
    "turn-id": "turn-company-1",
    "completed-at": "2026-07-28T10:00:00.000Z",
    "last-assistant-message": "公司任务完成",
  };
  const endpoint = `http://127.0.0.1:${agentPort}/internal/remote-agent-notify`;
  assert.equal(
    (await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event) }))
      .status,
    401,
  );
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ ...event, "thread-id": "invalid" }),
      })
    ).status,
    400,
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state.hasUnreadResult, true);
  assert.equal(result.notification.sent, 1);

  const settings = JSON.parse(await readFile(path.join(codexHome, "agent-session-settings.json"), "utf8"));
  assert.equal(settings[`company:${threadId}`].lastCompletedTurnId, "turn-company-1");
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries[0].target, { app: "agent" });
  assert.match(deliveries[0].notification.url, new RegExp(`host=company.*sessionId=${threadId}`));

  const duplicate = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);
  assert.equal(deliveries.length, 1);

  const laterEvent = {
    ...event,
    "turn-id": "turn-company-2",
    "completed-at": "2026-07-28T10:01:00.000Z",
  };
  assert.equal(
    (
      await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(laterEvent),
      })
    ).status,
    200,
  );
  const outOfOrderReplay = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  assert.equal((await outOfOrderReplay.json()).duplicate, true);
  const updatedSettings = JSON.parse(
    await readFile(path.join(codexHome, "agent-session-settings.json"), "utf8"),
  );
  assert.equal(updatedSettings[`company:${threadId}`].lastCompletedTurnId, "turn-company-2");
  assert.deepEqual(
    updatedSettings[`company:${threadId}`].recentCompletedTurnIds,
    ["turn-company-1", "turn-company-2"],
  );
  assert.equal(deliveries.length, 2);
  assert.doesNotMatch(output, /unreachable-company/);
});

test("company notify bridge preserves the existing notifier and forwards the completion", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-remote-notify-script-"));
  const configFile = path.join(root, "remote-notify.json");
  const chainScript = path.join(root, "chain.mjs");
  const chainOutput = path.join(root, "chain-output.json");
  let received = null;
  const receiver = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received = { authorization: req.headers.authorization, body: JSON.parse(body) };
      res.writeHead(200);
      res.end("ok");
    });
  });
  const port = await listen(receiver);
  t.after(() => receiver.close());
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    writeFile(chainScript, `import fs from "node:fs"; fs.writeFileSync(process.argv[2], process.argv.at(-1));\n`),
    writeFile(
      configFile,
      JSON.stringify({
        url: `http://127.0.0.1:${port}`,
        token,
        chain: [path.basename(process.execPath), chainScript, chainOutput],
      }),
    ),
    chmod(remoteNotifyScript, 0o755),
  ]);
  const event = {
    type: "agent-turn-complete",
    "thread-id": threadId,
    "turn-id": "turn-company-2",
  };
  await execFileAsync("python3", [remoteNotifyScript, JSON.stringify(event)], {
    env: { ...process.env, AGENT_REMOTE_NOTIFY_CONFIG: configFile },
  });
  await waitFor(() => received, 2_000);
  await waitFor(async () => {
    try {
      return JSON.parse(await readFile(chainOutput, "utf8"))["turn-id"] === "turn-company-2";
    } catch {
      return false;
    }
  }, 2_000);

  assert.equal(received.authorization, `Bearer ${token}`);
  assert.deepEqual(received.body, event);
});

test("the control center applies remote completions without opening a Session runtime", async () => {
  const [app, server] = await Promise.all([
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);
  assert.match(
    app,
    /payload\?\.type === "remote-completion"[\s\S]*applyRemoteCompletionEvent\(payload\)/,
  );
  assert.match(
    app,
    /function applyRemoteCompletionEvent\(payload\)[\s\S]*hasUnreadResult: true[\s\S]*loadSessionPreview\(sessionId/,
  );
  assert.doesNotMatch(
    app.slice(app.indexOf("function applyRemoteCompletionEvent"), app.indexOf("function scheduleControlCatalogRefresh")),
    /openSocket|startSession|resume/,
  );
  assert.match(
    server,
    /managedLiveSession[\s\S]*skipped: "managed-live-session"[\s\S]*if \(!managedLiveSession\)/,
  );
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
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
