import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Agent Web exposes dedicated Multi-Agent, thread tree, side chat, and Realtime V3 controls", async () => {
  const [page, client, realtime, styles, server] = await Promise.all([
    readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    readFile(new URL("../public/agent-realtime.js", import.meta.url), "utf8"),
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../server.js", import.meta.url), "utf8"),
  ]);

  for (const id of [
    "app-session-more",
    "app-session-agents",
    "app-session-tree",
    "app-session-side-chat",
    "app-session-realtime",
    "agent-manager-dialog",
    "thread-tree-dialog",
    "side-chat-dialog",
    "realtime-dialog",
  ]) {
    assert.match(page, new RegExp(`id="${id}"`));
  }
  assert.match(page, /agent-realtime\.js\?v=20260726-1[\s\S]*app\.js\?v=20260727-current-session-navigation-1/);
  assert.match(client, /type: "subagent-stop"/);
  assert.match(client, /type: "session-tree"/);
  assert.match(client, /type: "side-chat-submit"/);
  assert.match(client, /realtimeController\.handleMessage/);
  assert.match(realtime, /getUserMedia/);
  assert.match(realtime, /createScriptProcessor\(4096, 1, 1\)/);
  assert.match(realtime, /pcm16Base64/);
  assert.match(styles, /\.agent-card/);
  assert.match(styles, /\.thread-tree-list/);
  assert.match(styles, /\.side-chat-transcript/);
  assert.match(styles, /\.realtime-transcript/);
  assert.match(styles, /\.app-session-more-menu/);
  assert.match(server, /sandbox: "read-only"/);
  assert.match(server, /ephemeral: true/);
  assert.match(server, /version: "v3"/);
  assert.match(server, /outputModality: "audio"/);
});
