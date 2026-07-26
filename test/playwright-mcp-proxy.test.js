import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import test from "node:test";
import {
  ensureBrowserHandoff,
  PLAYWRIGHT_MCP_TOOLS,
  createPlaywrightMcpProxy,
} from "../lib/playwright-mcp-proxy.js";

test("Playwright tool discovery stays process-free and the first call starts one shared backend", async (t) => {
  let starts = 0;
  let closes = 0;
  let running = 0;
  let peakRunning = 0;
  const proxy = createPlaywrightMcpProxy({
    idleMs: 20,
    createConnection: async () => {
      starts += 1;
      return {
        pid: 2468,
        client: {
          async callTool({ name, arguments: args }) {
            running += 1;
            peakRunning = Math.max(peakRunning, running);
            await new Promise((resolve) => setTimeout(resolve, 5));
            running -= 1;
            return {
              content: [{ type: "text", text: JSON.stringify({ name, args }) }],
            };
          },
          async close() {
            closes += 1;
          },
        },
      };
    },
  });

  const app = express();
  app.use(express.json());
  app.post("/mcp", proxy.handlePost);
  app.get("/mcp", proxy.handleUnsupported);
  app.delete("/mcp", proxy.handleUnsupported);
  const server = http.createServer(app);
  await listen(server);
  t.after(async () => {
    await proxy.backend.close("test");
    await close(server);
  });

  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/mcp`);
  const firstClient = await connectClient(endpoint, "first");
  const secondClient = await connectClient(endpoint, "second");
  assert.equal(starts, 0);

  const [firstList, secondList] = await Promise.all([
    firstClient.listTools(),
    secondClient.listTools(),
  ]);
  assert.deepEqual(firstList.tools, PLAYWRIGHT_MCP_TOOLS);
  assert.deepEqual(secondList.tools, PLAYWRIGHT_MCP_TOOLS);
  assert.equal(firstList.tools.length, 24);
  assert.equal(starts, 0);

  const [firstResult, secondResult] = await Promise.all([
    firstClient.callTool({
      name: "browser_navigate",
      arguments: { url: "https://example.com" },
    }),
    secondClient.callTool({
      name: "browser_snapshot",
      arguments: {},
    }),
  ]);
  assert.deepEqual(JSON.parse(firstResult.content[0].text), {
    name: "browser_navigate",
    args: { url: "https://example.com" },
  });
  assert.deepEqual(JSON.parse(secondResult.content[0].text), {
    name: "browser_snapshot",
    args: {},
  });
  assert.equal(starts, 1);
  assert.equal(peakRunning, 1);

  await waitFor(() => proxy.backend.status().state === "stopped", 500);
  assert.equal(closes, 1);
  await Promise.all([firstClient.close(), secondClient.close()]);
});

test("Browser Hand-off is started through the canonical controller", async () => {
  let invocation = null;
  await ensureBrowserHandoff({
    controlPath: "/workspace/server-config/scripts/browser-handoffctl.sh",
    execFileImpl(file, args, options, callback) {
      invocation = { file, args, options };
      callback(null, "ready", "");
    },
  });

  assert.equal(
    invocation.file,
    "/workspace/server-config/scripts/browser-handoffctl.sh",
  );
  assert.deepEqual(invocation.args, ["start"]);
  assert.equal(invocation.options.timeout, 30_000);
});

async function waitFor(predicate, timeoutMs) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function connectClient(endpoint, name) {
  const client = new Client({
    name: `agent-web-playwright-proxy-${name}`,
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(endpoint);
  await client.connect(transport);
  return client;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
