import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import test from "node:test";
import {
  AMAP_MCP_TOOLS,
  createAmapMcpProxy,
  SharedOnDemandMcpBackend,
} from "../lib/amap-mcp-proxy.js";

test("the shared backend starts once for concurrent calls and exits after its idle timeout", async () => {
  let starts = 0;
  let closes = 0;
  let calls = 0;
  const backend = new SharedOnDemandMcpBackend({
    idleMs: 20,
    createConnection: async () => {
      starts += 1;
      return {
        pid: 4321,
        redact: (value) =>
          JSON.parse(JSON.stringify(value).replaceAll("provider-secret", "[redacted]")),
        client: {
          async callTool({ name }) {
            calls += 1;
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { content: [{ type: "text", text: `${name}:provider-secret` }] };
          },
          async close() {
            closes += 1;
          },
        },
      };
    },
  });

  assert.equal(backend.status().state, "stopped");
  const [first, second] = await Promise.all([
    backend.callTool({ name: "first" }),
    backend.callTool({ name: "second" }),
  ]);

  assert.equal(starts, 1);
  assert.equal(calls, 2);
  assert.equal(first.content[0].text, "first:[redacted]");
  assert.equal(second.content[0].text, "second:[redacted]");
  assert.equal(backend.status().state, "running");

  await waitFor(() => backend.status().state === "stopped", 500);
  assert.equal(closes, 1);
});

test("HTTP initialization and tool listing stay process-free; the first tool call starts the shared backend", async (t) => {
  let starts = 0;
  let closes = 0;
  const proxy = createAmapMcpProxy({
    idleMs: 20,
    createConnection: async () => {
      starts += 1;
      return {
        pid: 1234,
        client: {
          async callTool({ name, arguments: args }) {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ name, args }),
                },
              ],
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

  const client = new Client({
    name: "agent-web-amap-proxy-test",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${server.address().port}/mcp`),
  );
  await client.connect(transport);
  assert.equal(starts, 0);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools, AMAP_MCP_TOOLS);
  assert.equal(starts, 0);

  const result = await client.callTool({
    name: "maps_geo",
    arguments: {
      address: "北京市朝阳区金泉家园",
      city: "北京",
    },
  });
  assert.deepEqual(JSON.parse(result.content[0].text), {
    name: "maps_geo",
    args: {
      address: "北京市朝阳区金泉家园",
      city: "北京",
    },
  });
  assert.equal(starts, 1);

  await waitFor(() => proxy.backend.status().state === "stopped", 500);
  assert.equal(closes, 1);
  await client.close();
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

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function close(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
