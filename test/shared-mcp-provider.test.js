import assert from "node:assert/strict";
import test from "node:test";
import { SharedOnDemandMcpBackend } from "../lib/shared-mcp-provider.js";

test("serialized shared providers run one tool call at a time", async () => {
  let running = 0;
  let peakRunning = 0;
  let starts = 0;
  let closes = 0;
  const backend = new SharedOnDemandMcpBackend({
    providerId: "serialized-test",
    idleMs: 20,
    serializeCalls: true,
    createConnection: async () => {
      starts += 1;
      return {
        client: {
          async callTool({ name }) {
            running += 1;
            peakRunning = Math.max(peakRunning, running);
            await new Promise((resolve) => setTimeout(resolve, 10));
            running -= 1;
            return { content: [{ type: "text", text: name }] };
          },
          async close() {
            closes += 1;
          },
        },
      };
    },
  });

  const [first, second] = await Promise.all([
    backend.callTool({ name: "first" }),
    backend.callTool({ name: "second" }),
  ]);

  assert.equal(starts, 1);
  assert.equal(peakRunning, 1);
  assert.equal(first.content[0].text, "first");
  assert.equal(second.content[0].text, "second");
  assert.equal(backend.status().serialized, true);

  await waitFor(() => backend.status().state === "stopped", 500);
  assert.equal(closes, 1);
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
