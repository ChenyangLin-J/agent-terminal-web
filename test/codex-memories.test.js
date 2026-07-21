import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  projectMemorySections,
  readCodexMemoryStatus,
  readCodexMemoryView,
} from "../lib/codex-memories.js";

test("Codex memory status reflects config and generated files", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    "[features]\nmemories = true\n\n[memories]\ngenerate_memories = true\nuse_memories = true\ndisable_on_external_context = false\n",
  );
  await fs.writeFile(path.join(codexHome, "memories", "memory_summary.md"), "# Overview\nUseful profile\n");

  const status = await readCodexMemoryStatus(codexHome);
  assert.equal(status.enabled, true);
  assert.equal(status.generateMemories, true);
  assert.equal(status.useMemories, true);
  assert.equal(status.ready, true);
  assert.equal(status.documents.overview.available, true);
  assert.equal(status.documents.detail.available, false);
});

test("project memory view keeps matching project sections separate", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const detail = [
    "# Memory",
    "General preference",
    "## Tibetan learning tool",
    "Project: /home/ubuntu/workspace/tibetan-learning-tool",
    "Always update the audio segmentation method after a correction.",
    "## Personal site",
    "Project: /home/ubuntu/workspace/personal-site",
    "Thoughts are published here.",
  ].join("\n");
  await fs.writeFile(path.join(codexHome, "memories", "MEMORY.md"), detail);

  const result = await readCodexMemoryView(codexHome, {
    view: "detail",
    project: "/home/ubuntu/workspace/tibetan-learning-tool",
  });
  assert.match(result.document.content, /audio segmentation/);
  assert.doesNotMatch(result.document.content, /Thoughts are published/);
});

test("memory source reads are restricted to generated Markdown summaries", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const sourceRoot = path.join(codexHome, "memories", "rollout_summaries");
  await fs.writeFile(path.join(sourceRoot, "session-one.md"), "# Session one\nEvidence\n");

  const listed = await readCodexMemoryView(codexHome, { view: "sources" });
  assert.deepEqual(listed.sources.map((source) => source.name), ["session-one.md"]);

  const selected = await readCodexMemoryView(codexHome, { view: "sources", source: "session-one.md" });
  assert.match(selected.selected.content, /Evidence/);

  const escaped = await readCodexMemoryView(codexHome, { view: "sources", source: "../config.toml" });
  assert.equal(escaped.selected, null);
});

test("project memory explains when no generated section matches", () => {
  const result = projectMemorySections("# Memory\nOnly global context", "personal-site");
  assert.match(result, /还没有可识别的长期记忆/);
  assert.match(result, /personal-site/);
});

test("Agent Web exposes memory review views and authenticated APIs", async () => {
  const [server, app, page, styles] = await Promise.all([
    fs.readFile(new URL("../server.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/app.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/index.html", import.meta.url), "utf8"),
    fs.readFile(new URL("../public/agent-memories.css", import.meta.url), "utf8"),
  ]);
  assert.match(server, /app\.use\("\/api", requireAuth\)[\s\S]*app\.get\("\/api\/memories\/status"/);
  assert.match(server, /app\.get\("\/api\/memories"/);
  assert.match(page, /id="open-memories"/);
  assert.match(page, /id="app-session-memories"/);
  assert.doesNotMatch(page, /id="open-memories" class="hidden"/);
  assert.match(page, /data-memory-view="overview"/);
  assert.match(page, /data-memory-view="detail"/);
  assert.match(page, /data-memory-view="pending"/);
  assert.match(page, /data-memory-view="sources"/);
  assert.match(page, /agent-memories\.js\?v=/);
  assert.match(await fs.readFile(new URL("../public/agent-memories.js", import.meta.url), "utf8"), /查看已抽取内容/);
  assert.match(app, /name: "\/memories"/);
  assert.match(app, /AgentMemories\?\.open/);
  assert.match(styles, /\.memory-dialog/);
});

async function temporaryCodexHome(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memories-"));
  await fs.mkdir(path.join(root, "memories", "rollout_summaries"), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
