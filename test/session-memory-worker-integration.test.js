import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import { applyPersonalMemoryProposals, deletePersonalMemoryEntry, readPersonalMemoryStore, updatePersonalMemoryEntry } from "../lib/personal-memories.js";

const execute = promisify(execFile);
const script = new URL("../scripts/personal-memory-worker.mjs", import.meta.url).pathname;
const userText = "我在读一本沟通书，今天读完一个章节，开始做单人练习，明天还想继续。";

test("a zero-candidate extraction records its reason and advances only the reviewed range", async (t) => {
  const fixture = await createFixture(t, {
    review: {
      assessment: "no_candidates",
      rationale: "当前阅读和练习已被同一条具体活动记忆覆盖。",
      skipped: [{ reason: "already_covered", evidenceQuote: userText, matchedId: "now-reading", rationale: "已有条目包含同一本书和同一练习的继续计划。" }],
    },
    proposals: [], projectRules: [], skills: [],
  });
  await fixture.run();
  const runtime = JSON.parse(await fs.readFile(fixture.runtime, "utf8"));
  assert.equal(runtime.lastRun.processed, 1);
  assert.equal(runtime.lastRun.created, 0);
  assert.equal(runtime.lastRun.failed, 0);
  assert.equal(runtime.threads["thread-reading"].lastEventAt, "2026-10-06T14:20:00.000Z");
  assert.equal(runtime.threads["thread-reading"].lastExtraction.assessment, "no_candidates");
  const records = (await fs.readFile(fixture.diagnostics, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1);
  assert.equal(records[0].modelReview.skipped[0].matchedId, "now-reading");
  assert.equal(records[0].emitted.proposals, 0);
});

test("an explicit ongoing reading activity is applied to Now alongside a broad existing goal", async (t) => {
  const activity = "近期在读沟通书，已读完一个章节，并开始单人练习，计划继续练习。";
  const fixture = await createFixture(t, {
    review: { assessment: "actionable", rationale: "具体阅读和练习没有被泛化的沟通目标覆盖。", skipped: [] },
    proposals: [{
      action: "create", mergePendingId: "", targetId: "", scope: "global", project: "", aliases: [],
      category: "当前重点", text: activity, confidence: 0.95, explicit: true, conflict: false, sensitive: false,
      evidenceQuote: userText, rationale: "用户描述进度并明确希望明天继续。",
    }],
    projectRules: [], skills: [],
  }, false);
  await fixture.run();
  const runtime = JSON.parse(await fs.readFile(fixture.runtime, "utf8"));
  assert.equal(runtime.lastRun.confirmed, 1);
  assert.equal(runtime.lastRun.failed, 0);
  assert.equal(runtime.threads["thread-reading"].lastExtraction.emitted.proposals, 1);
  assert.ok((await fs.readFile(path.join(fixture.memoryRoot, "Now.md"), "utf8")).includes(activity));
  assert.ok((await fs.readFile(path.join(fixture.memoryRoot, "Core.md"), "utf8")).includes("希望改善沟通"));
});

for (const [name, review] of [
  ["missing review", undefined],
  ["generic explanation with no evaluated fresh fact", { assessment: "no_candidates", rationale: "没有符合条件的信息。", skipped: [] }],
]) {
  test(`a zero result with ${name} fails without consuming the completed user turn`, async (t) => {
    const fixture = await createFixture(t, { review, proposals: [], projectRules: [], skills: [] });
    await fixture.run();
    const runtime = JSON.parse(await fs.readFile(fixture.runtime, "utf8"));
    assert.equal(runtime.lastRun.failed, 1);
    assert.equal(runtime.lastRun.processed, 0);
    assert.equal(runtime.threads["thread-reading"].lastEventAt, "2026-10-06T13:00:01.000Z");
    assert.equal(runtime.threads["thread-reading"].retryCount, 1);
    await assert.rejects(fs.access(fixture.diagnostics), { code: "ENOENT" });
  });
}

for (const [name, fields] of [
  ["non-global scope", { scope: "project", project: "workspace" }],
  ["unknown update target", { action: "update", targetId: "missing-memory" }],
  ["unknown retirement target", { action: "retire", targetId: "missing-memory" }],
  ["unknown pending merge", { mergePendingId: "missing-change" }],
]) {
  test(`a candidate with ${name} fails without advancing its watermark`, async (t) => {
    const fixture = await createFixture(t, {
      review: { assessment: "actionable", rationale: "应记录当前学习活动。", skipped: [] },
      proposals: [{ action: "create", scope: "global", text: "近期读书和练习。", targetId: "", mergePendingId: "", evidenceQuote: userText, ...fields }],
      projectRules: [], skills: [],
    });
    await fixture.run();
    const runtime = JSON.parse(await fs.readFile(fixture.runtime, "utf8"));
    assert.equal(runtime.lastRun.failed, 1);
    assert.equal(runtime.lastRun.processed, 0);
    assert.equal(runtime.threads["thread-reading"].lastEventAt, "2026-10-06T13:00:01.000Z");
    assert.equal(runtime.threads["thread-reading"].retryCount, 1);
  });
}

test("a user edit during model extraction invalidates the old snapshot without consuming the turn", async (t) => {
  const fixture = await createFixture(t, {
    review: { assessment: "actionable", rationale: "更新当前阅读进度。", skipped: [] },
    proposals: [{ action: "update", scope: "global", text: "旧模型给出的阅读进度。", targetId: "now-reading", mergePendingId: "", evidenceQuote: userText }],
    projectRules: [], skills: [],
  }, true, '<!-- memory-file: {"kind":"now","title":"当前关注"} -->\n# 当前关注\n\n## 当前重点\n\n- 用户刚刚修改的新阅读安排。 ^now-reading\n');
  await fixture.run();
  const runtime = JSON.parse(await fs.readFile(fixture.runtime, "utf8"));
  assert.equal(runtime.lastRun.failed, 1);
  assert.match(runtime.lastError, /提取期间/);
  assert.equal(runtime.threads["thread-reading"].lastEventAt, "2026-10-06T13:00:01.000Z");
  assert.match(await fs.readFile(path.join(fixture.memoryRoot, "Now.md"), "utf8"), /用户刚刚修改的新阅读安排/);
});

for (const change of ["edit", "delete"]) {
  test(`the write lock prevents an old extraction from undoing a user ${change}`, async (t) => {
    const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "memory-target-concurrency-"));
    t.after(() => fs.rm(codexHome, { recursive: true, force: true }));
    const [created] = await applyPersonalMemoryProposals(codexHome, [{ action: "create", scope: "global", category: "当前重点", text: "原始阅读计划。", explicit: true, confidence: 0.95 }]);
    const expected = (await readPersonalMemoryStore(codexHome)).entries.find((entry) => entry.id === created.id);
    if (change === "edit") await updatePersonalMemoryEntry(codexHome, created.id, { text: "用户的新阅读计划。" });
    else await deletePersonalMemoryEntry(codexHome, created.id);
    await assert.rejects(applyPersonalMemoryProposals(codexHome, [{ action: "update", targetId: created.id, scope: "global", category: "当前重点", text: "旧提取的新内容。", explicit: true, confidence: 0.95 }], {}, { expectedTargets: { [created.id]: expected } }), { code: "MEMORY_PROPOSAL_STALE_TARGET" });
    const current = (await readPersonalMemoryStore(codexHome)).entries.find((entry) => entry.id === created.id);
    if (change === "edit") assert.equal(current.text, "用户的新阅读计划。");
    else assert.equal(current, undefined);
  });
}

async function createFixture(t, output, existingReading = true, memoryRewrite = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "session-memory-worker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "codex");
  const memoryRoot = path.join(root, "vault", "System", "Memory");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.mkdir(memoryRoot, { recursive: true });
  await fs.writeFile(path.join(memoryRoot, "Core.md"), '<!-- memory-file: {"kind":"core","title":"核心记忆"} -->\n# 核心记忆\n\n## 价值取向\n\n- 希望改善沟通与表达。 ^broad-communication-goal\n');
  await fs.writeFile(path.join(memoryRoot, "Now.md"), '<!-- memory-file: {"kind":"now","title":"当前关注"} -->\n# 当前关注\n' + (existingReading ? '\n## 当前重点\n\n- ' + userText + ' ^now-reading\n' : ''));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [message("2026-10-06T13:00:00Z", "user", "我想改善沟通。"), message("2026-10-06T13:00:01Z", "assistant", "可以从具体交流开始。")].join("\n") + "\n");
  const db = new DatabaseSync(path.join(codexHome, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT, title TEXT, source TEXT, cwd TEXT, rollout_path TEXT, updated_at_ms INTEGER, updated_at INTEGER, archived INTEGER, agent_role TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("thread-reading", "读书与练习", "cli", root, rollout, Date.now() - 120_000, 0, 0, null);
  db.close();
  const command = path.join(root, "fake-codex.mjs");
  await fs.writeFile(command, '#!' + process.execPath + '\nimport fs from "node:fs";\nconst args = process.argv.slice(2);\nprocess.stdin.resume();\nprocess.stdin.on("end", () => {\n  if (process.env.FIXTURE_MEMORY_REWRITE) fs.writeFileSync(process.env.FIXTURE_MEMORY_FILE, process.env.FIXTURE_MEMORY_REWRITE);\n  fs.writeFileSync(args[args.indexOf("-o") + 1], process.env.FIXTURE_EXTRACTION_OUTPUT);\n  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:20,output_tokens:10}}));\n});\n', { mode: 0o700 });
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_COMMAND: command,
    PERSONAL_MEMORY_MARKDOWN_ROOT: memoryRoot,
    OBSIDIAN_VAULT_PATH: path.join(root, "vault"),
    MEMORY_SYSTEM_RUNTIME_ROOT: path.join(codexHome, "memory-system"),
    HOME_CAPTURE_JOBS_FILE: path.join(root, "missing-captures.json"),
    FIXTURE_EXTRACTION_OUTPUT: JSON.stringify(output),
    FIXTURE_MEMORY_REWRITE: memoryRewrite,
    FIXTURE_MEMORY_FILE: path.join(memoryRoot, "Now.md"),
  };
  await execute(process.execPath, [script, "--initialize"], { env });
  await fs.appendFile(rollout, [message("2026-10-06T14:19:00Z", "user", userText), message("2026-10-06T14:20:00Z", "assistant", "已保存练习记录，明天可以接着练。")].join("\n") + "\n");
  return {
    memoryRoot,
    runtime: path.join(codexHome, "personal-memories", "worker-state.json"),
    diagnostics: path.join(codexHome, "memory-system", "session-extractions.jsonl"),
    run: () => execute(process.execPath, [script], { env }),
  };
}

function message(timestamp, role, text) {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role, phase: role === "assistant" ? "final_answer" : null, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
}
