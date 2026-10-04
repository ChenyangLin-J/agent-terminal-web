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
const parentThreadId = "019f9db5-cdfd-7c10-b477-4859c23313d0";
const childThreadId = "019f9db5-cdfd-7c10-b477-4859c23313d1";
const childTurnId = "019f9db5-cdfd-7c10-b477-4859c23313d2";
const fallbackThreadId = "019f9db5-cdfd-7c10-b477-4859c23313d3";

test("a child Agent opens as a live read-only transcript without resuming its thread", async (t) => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "agent-subagent-live-preview-"));
  const workspaceRoot = path.join(temporaryRoot, "workspace");
  const codexHome = path.join(temporaryRoot, "codex");
  const fakeCodex = path.join(temporaryRoot, "fake-codex.js");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "09");
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    path.join(sessionDirectory, `rollout-${fallbackThreadId}.jsonl`),
    `${[
      {
        timestamp: "2026-08-09T13:00:00.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "Old disk prompt" },
      },
      {
        timestamp: "2026-08-09T13:00:01.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "Old disk answer" }],
        },
      },
    ].map(JSON.stringify).join("\n")}\n`,
  );
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
    send({ id: message.id, result: { thread: { id: "${parentThreadId}", turns: [] } } });
  } else if (message.method === "thread/read") {
    if (message.params.threadId === "${fallbackThreadId}") {
      send({ id: message.id, error: { message: "transient live read failure" } });
      return;
    }
    const child = message.params.threadId === "${childThreadId}";
    send({
      id: message.id,
      result: {
        thread: {
          id: message.params.threadId,
          status: child ? { type: "active" } : { type: "idle" },
          turns: []
        }
      }
    });
  } else if (message.method === "thread/turns/list") {
    if (message.params.threadId === "${fallbackThreadId}") {
      send({ id: message.id, error: { message: "transient live list failure" } });
      return;
    }
    if (message.params.threadId !== "${childThreadId}") {
      send({ id: message.id, result: { data: [], nextCursor: null } });
      return;
    }
    process.stderr.write("CHILD_LIST\\n");
    send({
      id: message.id,
      result: {
        data: [{
          id: "${childTurnId}",
          startedAt: 1786283200,
          status: "inProgress",
          items: [
            {
              id: "child-prompt",
              type: "userMessage",
              content: [{ type: "text", text: "Inspect the live child thread" }]
            },
            {
              id: "child-commentary",
              type: "agentMessage",
              phase: "commentary",
              text: "Reading live child output"
            },
            {
              id: "child-command",
              type: "commandExecution",
              command: "node inspect.js",
              cwd: "/workspace",
              aggregatedOutput: "partial result",
              status: "inProgress"
            }
          ]
        }],
        nextCursor: null
      }
    });
  } else if (message.method === "thread/resume" && message.params.threadId === "${childThreadId}") {
    process.stderr.write("CHILD_RESUME_ATTEMPT\\n");
    send({ id: message.id, error: { message: "child preview must not resume" } });
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

  const parent = await connect(
    `ws://127.0.0.1:${agentPort}/terminal?cwd=.&transport=app-server&access=safe&clientId=parent-preview-source`,
  );
  t.after(() => parent.ws.close());
  const ready = await parent.next(
    (message) => message.type === "status" && message.payload.ready && message.payload.sessionId === parentThreadId,
  );

  const unavailable = await fetch(`http://127.0.0.1:${agentPort}/api/session-preview/${childThreadId}`);
  assert.equal(unavailable.status, 404);

  const previewResponse = await fetch(
    `http://127.0.0.1:${agentPort}/api/session-preview/${childThreadId}?sourceSession=${ready.payload.id}`,
  );
  assert.equal(previewResponse.status, 200);
  assert.match(previewResponse.headers.get("cache-control") || "", /no-store/);
  const preview = await previewResponse.json();
  assert.equal(preview.live, true);
  assert.equal(preview.active, true);
  assert.equal(preview.conversation.turns[0].user, "Inspect the live child thread");
  assert.deepEqual(
    preview.transcript.items.map((item) => [item.type, item.text, item.output]),
    [
      ["user", "Inspect the live child thread", ""],
      ["assistant", "Reading live child output", ""],
      ["command", "node inspect.js", "partial result"],
    ],
  );

  const fallbackResponse = await fetch(
    `http://127.0.0.1:${agentPort}/api/session-preview/${fallbackThreadId}?sourceSession=${ready.payload.id}`,
  );
  assert.equal(fallbackResponse.status, 200);
  const fallback = await fallbackResponse.json();
  assert.equal(fallback.live, true);
  assert.equal(fallback.active, true);
  assert.equal(fallback.conversation.turns[0].assistant[0].text, "Old disk answer");

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(
    `http://127.0.0.1:${agentPort}/?preview=1&cwd=.&sessionId=${childThreadId}` +
      `&sourceSession=${ready.payload.id}&title=Live%20child&access=safe`,
  );
  await page.getByText("Reading live child output", { exact: true }).waitFor();
  await page.getByText("node inspect.js", { exact: true }).waitFor();
  await page.getByText('子 Agent · 只读 · 运行中 · 自动更新', { exact: true }).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('sourceSession'), ready.payload.id);
  assert.equal(await page.locator('.cwu-composer textarea').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '语音输入', exact: true }).isDisabled(), true);
  assert.equal(output.includes('CHILD_RESUME_ATTEMPT'), false);

  await page.getByRole('button', { name: '新建对话', exact: true }).click();
  await page.locator('.cwu-session-header').getByRole('heading', { name: '新对话', exact: true }).waitFor();
  await new Promise(resolve => setTimeout(resolve, 100));
  const afterLeaving = occurrences(output, 'CHILD_LIST');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(occurrences(output, 'CHILD_LIST'), afterLeaving, 'Leaving a preview releases its polling');
  await page.goto(`http://127.0.0.1:${agentPort}/?sessionId=${childThreadId}&sourceSession=${ready.payload.id}`);
  await waitFor(() => occurrences(output, 'CHILD_LIST') > afterLeaving, 3000);

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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for isolated Agent Web");
}

function occurrences(value, pattern) {
  return String(value || "").split(pattern).length - 1;
}
