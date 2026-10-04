import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const threadId = "019f9db5-cdfd-7c10-b477-4859c23313be";
const activeThreadId = "019f9db5-cdfd-7c10-b477-4859c23313c0";
const activeTurnId = "019f9db5-cdfd-7c10-b477-4859c23313c1";

test("an idle App Server runtime is released even while its page remains connected", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-app-runtime-lease-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "fake" } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "${threadId}", turns: [] } } });
  } else if (message.method === "thread/resume") {
    const active = message.params.threadId === "${activeThreadId}";
    send({
      id: message.id,
      result: {
        thread: { id: message.params.threadId, turns: [] },
        initialTurnsPage: {
          data: active
            ? [{
                id: "${activeTurnId}",
                status: "inProgress",
                items: [{
                  id: "active-user-message",
                  type: "userMessage",
                  content: [{ type: "text", text: "仍在运行的恢复任务" }]
                }]
              }]
            : [],
          nextCursor: null
        }
      }
    });
  } else if (message.method === "turn/start") {
    const turn = { id: "019f9db5-cdfd-7c10-b477-4859c23313bf", status: "completed" };
    send({ id: message.id, result: { turn } });
    setTimeout(() => {
      send({ method: "turn/started", params: { threadId: "${threadId}", turn } });
      send({ method: "turn/completed", params: { threadId: "${threadId}", turn } });
    }, 10);
  } else if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});
`,
  );
  await chmod(fakeCodex, 0o755);

  const authServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"authenticated":true}');
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  t.after(() => authServer.close());

  const agentPort = await reservePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(agentPort),
      CODEX_HOME: codexHome,
      WORKSPACE_ROOT: workspaceRoot,
      CODEX_APP_SERVER_COMMAND: fakeCodex,
      AGENT_NATIVE_THREAD_CATALOG: "0",
      SESSION_TTL_MS: "1200",
      PRIVATE_AUTH_VERIFY_URL: `http://127.0.0.1:${authServer.address().port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  await waitFor(() => output.includes("Agent Terminal Web:"), 5_000);

  const controlAbort = new AbortController();
  t.after(() => controlAbort.abort());
  const controlResponse = await fetch(`http://127.0.0.1:${agentPort}/api/control-events`, {
    signal: controlAbort.signal,
  });
  assert.equal(controlResponse.status, 200);
  assert.match(controlResponse.headers.get("content-type") || "", /text\/event-stream/);
  const controlStream = {
    reader: controlResponse.body.getReader(),
    decoder: new TextDecoder(),
    buffer: "",
    events: [],
  };
  await nextControlEvent(controlStream, (event) => event.type === "ready");

  const resumedActiveClient = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&sessionId=${activeThreadId}&transport=app-server&access=safe&clientId=resumed-active`,
  );
  const resumedActive = await resumedActiveClient.next(
    (message) => message.type === "status" && message.payload.ready,
    8_000,
  );
  assert.equal(resumedActive.payload.turnState.active, true);
  assert.equal(resumedActive.payload.turnState.turnId, activeTurnId);
  assert.equal(resumedActive.payload.turnState.requirements[0]?.text, "仍在运行的恢复任务");
  const activeSessionsResponse = await fetch(`http://127.0.0.1:${agentPort}/api/sessions`);
  const activeSessions = (await activeSessionsResponse.json()).sessions;
  assert.equal(
    activeSessions.find((session) => session.id === resumedActive.payload.id)?.turnState.active,
    true,
  );
  resumedActiveClient.ws.close();

  const client = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=idle-page`,
  );
  const ready = await client.next(
    (message) => message.type === "status" && message.payload.ready && message.payload.sessionId === threadId,
  );
  const pushedReady = await nextControlEvent(
    controlStream,
    (event) => event.type === "session" && event.session?.id === ready.payload.id && event.session?.ready,
  );
  assert.equal(pushedReady.session.sessionId, threadId);
  client.ws.send(JSON.stringify({ type: "client-ping", sentAt: Date.now() }));
  await client.next((message) => message.type === "client-pong");

  const released = await client.next(
    (message) => message.type === "status" && message.payload.released,
    3_000,
  );
  assert.equal(released.payload.id, ready.payload.id);
  assert.equal(released.payload.releaseReason, "idle-ttl");
  const pushedRelease = await nextControlEvent(
    controlStream,
    (event) => event.type === "session" && event.session?.id === ready.payload.id && event.session?.released,
  );
  assert.equal(pushedRelease.session.releaseReason, "idle-ttl");
  assert.equal(client.ws.readyState, WebSocket.OPEN);
  await delay(100);
  assert.equal(client.ws.readyState, WebSocket.OPEN);

  const response = await fetch(`http://127.0.0.1:${agentPort}/api/sessions`);
  const data = await response.json();
  const paused = data.sessions.find((session) => session.id === ready.payload.id);
  assert.equal(paused?.released, true);
  assert.equal(paused?.suspended, true);
  assert.match(output, /"event":"session-runtime-release".*"reason":"idle-ttl".*"connectedClients":1/);
  client.ws.close();

  const activeClient = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=active-page`,
  );
  const activeReady = await activeClient.next(
    (message) => message.type === "status" && message.payload.ready,
  );
  await delay(700);
  activeClient.ws.send(JSON.stringify({ type: "set-access", access: "full" }));
  await activeClient.next(
    (message) => message.type === "control-ack" && message.payload.kind === "access",
  );
  await delay(650);
  const renewedResponse = await fetch(`http://127.0.0.1:${agentPort}/api/sessions`);
  const renewedData = await renewedResponse.json();
  assert.equal(
    renewedData.sessions.find((session) => session.id === activeReady.payload.id)?.released,
    false,
  );
  const renewedRelease = await activeClient.next(
    (message) => message.type === "status" && message.payload.released,
    2_000,
  );
  assert.equal(renewedRelease.payload.releaseReason, "idle-ttl");
  activeClient.ws.close();

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const desktopPage = await desktopContext.newPage();
  const mobilePage = await mobileContext.newPage();
  const viewedClient = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=viewed-runtime`,
  );
  const viewedReady = await viewedClient.next(
    (message) => message.type === "status" && message.payload.ready,
  );
  viewedClient.ws.send(JSON.stringify({ type: "set-access", access: "full" }));
  await viewedClient.next(
    (message) => message.type === "control-ack" && message.payload.kind === "access",
  );
  const sessionUrl =
    `http://127.0.0.1:${agentPort}/?attach=${viewedReady.payload.id}` +
    `&cwd=.&sessionId=${threadId}&title=Idle%20preview&transport=app-server&access=full`;
  await Promise.all([
    desktopPage.goto(sessionUrl),
    mobilePage.goto(sessionUrl),
  ]);
  await Promise.all([desktopPage.locator('.cwu-composer textarea').waitFor(), mobilePage.locator('.cwu-composer textarea').waitFor()]);
  await Promise.all([desktopPage.waitForURL(url => url.searchParams.get('preview') === '1'), mobilePage.waitForURL(url => url.searchParams.get('preview') === '1')]);
  for (const page of [desktopPage, mobilePage]) {
    assert.equal(new URL(page.url()).searchParams.has('attach'), false);
    assert.equal(await page.locator('.cwu-composer textarea').isEnabled(), true);
  }
  const mobilePromptFontSize = await mobilePage.locator('.cwu-composer textarea').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
  assert.ok(mobilePromptFontSize >= 16);
  await desktopPage.locator('.cwu-composer textarea').fill('发送时重新恢复');
  await desktopPage.locator('.cwu-composer button[type=submit]').click();
  await desktopPage.waitForURL(url => Boolean(url.searchParams.get('attach')), { timeout: 5000 });
  assert.equal(new URL(desktopPage.url()).searchParams.has('preview'), false);
  desktopPage.once('dialog', dialog => dialog.accept());
  await desktopPage.locator('.cwu-product-session-tools summary').click();
  await desktopPage.getByRole('button', { name: '结束当前 Session', exact: true }).click();
  await desktopPage.waitForURL(url => url.searchParams.get('new') === '1', { timeout: 5000 });
  assert.equal(await desktopPage.locator('.cwu-composer textarea').isEnabled(), true);
  viewedClient.ws.close();
});

async function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queue.push(message);
  });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return {
    ws,
    next(predicate, timeoutMs = 2_000) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const waiterIndex = waiters.indexOf(waiter);
          if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
          reject(new Error(`Timed out waiting for ${url}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
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
    await delay(20);
  }
  throw new Error("Timed out waiting for isolated Agent Web");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function nextControlEvent(stream, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const queuedIndex = stream.events.findIndex(predicate);
    if (queuedIndex >= 0) return stream.events.splice(queuedIndex, 1)[0];
    const remainingMs = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      stream.reader.read(),
      delay(remainingMs).then(() => ({ timeout: true })),
    ]);
    if (result.timeout) break;
    if (result.done) break;
    stream.buffer += stream.decoder.decode(result.value, { stream: true });
    const blocks = stream.buffer.split("\n\n");
    stream.buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .join("\n");
      if (!data) continue;
      stream.events.push(JSON.parse(data));
    }
  }
  throw new Error("Timed out waiting for a control event");
}
