import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent Web exposes dedicated Multi-Agent, thread tree, side chat, and Realtime V3 controls", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");

  assert.match(server, /sandbox: "read-only"/);
  assert.match(server, /ephemeral: true/);
  assert.match(server, /version: "v3"/);
  assert.match(server, /REALTIME_V3_VOICES\.includes\(voice\) \? voice : DEFAULT_REALTIME_V3_VOICE/);
  assert.match(server, /normalizeRealtimeTransport\(transport\)/);
  assert.match(server, /broadcast\(session, "realtime-sdp", \{ sdp \}\)/);
  assert.match(server, /outputModality: "audio"/);
});
