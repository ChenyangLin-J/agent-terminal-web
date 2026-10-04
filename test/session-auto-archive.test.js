import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS,
  MediaSessionAutoArchiveStore,
  mediaExtractionKind,
} from "../lib/session-auto-archive.js";

const firstSessionId = "019f9db4-cdfd-7c10-b477-4859c23313be";
const secondSessionId = "019f9db5-cdfd-7c10-b477-4859c23313be";

test("recognizes supported media extraction prompts with strict hostnames", () => {
  assert.equal(mediaExtractionKind("https://v.douyin.com/abc123/"), "douyin");
  assert.equal(mediaExtractionKind("https://www.douyin.com/video/123"), "douyin");
  assert.equal(mediaExtractionKind("xhslink.cn/aBcD"), "xiaohongshu");
  assert.equal(mediaExtractionKind("https://www.xiaohongshu.com/explore/123"), "xiaohongshu");
  assert.equal(
    mediaExtractionKind("8.32 复制打开抖音，看看【这条作品】 https://v.douyin.com/AbCd/ 03/19"),
    "douyin",
  );
  assert.equal(
    mediaExtractionKind("标题 - 小红书\n复制后打开小红书，查看完整笔记！ https://xhslink.com/a1b2"),
    "xiaohongshu",
  );
  assert.equal(
    mediaExtractionKind("请帮我生成逐字稿并存档 https://www.douyin.com/video/123"),
    "douyin",
  );
  assert.equal(mediaExtractionKind("$douyin-transcript"), "douyin");
  assert.equal(mediaExtractionKind("anything", ["xiaohongshu-transcript"]), "xiaohongshu");
});

test("does not infer extraction from platform names, spoofed links, or analysis requests", () => {
  assert.equal(mediaExtractionKind("帮我看看抖音最近有什么趋势"), "");
  assert.equal(mediaExtractionKind("小红书"), "");
  assert.equal(mediaExtractionKind("https://douyin.com.evil.test/video/123"), "");
  assert.equal(mediaExtractionKind("https://evil.test/?next=https://xhslink.cn/a"), "");
  assert.equal(mediaExtractionKind("分析一下 https://v.douyin.com/abc123/"), "");
  assert.equal(mediaExtractionKind("请研究这个 https://www.xiaohongshu.com/explore/123"), "");
  assert.equal(mediaExtractionKind("只要摘要，不要提取 https://v.douyin.com/abc123/"), "");
  assert.equal(mediaExtractionKind("我把这个链接放在材料里 https://v.douyin.com/abc123/，无需处理"), "");
});

test("tracks only a qualifying first prompt and becomes due at the two-hour boundary", async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = new MediaSessionAutoArchiveStore(filePath);
  const startedAt = 1_800_000_000_000;

  assert.equal(store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: "https://v.douyin.com/abc/",
    now: startedAt,
  }), null);
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }), null);

  const tracked = store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: "https://v.douyin.com/abc/",
    isFirstPrompt: true,
    now: startedAt,
  });
  assert.equal(tracked.kind, "douyin");
  assert.equal(store.dueRecords(startedAt + MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS * 2).length, 0);

  const completedAt = startedAt + MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS * 2;
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-1",
    now: completedAt,
  });
  assert.deepEqual(store.dueRecords(completedAt + MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS - 1), []);
  assert.deepEqual(store.dueRecords(completedAt + MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS), [{
    hostId: "personal",
    sessionId: firstSessionId,
    kind: "douyin",
    lastUserMessageAt: startedAt,
    completedAt,
    lastCompletedTurnId: "turn-1",
    dueAt: completedAt + MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS,
  }]);
});

test("a follow-up clears the deadline and a later completion starts a fresh idle period", async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = new MediaSessionAutoArchiveStore(filePath, { idleMs: 100 });
  track(store, { now: 1_000 });
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-1",
    now: 1_100,
  });
  assert.equal(store.dueRecords(1_200).length, 1);

  store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: "再检查一下第三段",
    now: 1_201,
  });
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }).completedAt, null);
  assert.equal(store.dueRecords(9_999).length, 0);

  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-2",
    now: 2_000,
  });
  assert.equal(store.dueRecords(2_099).length, 0);
  assert.equal(store.dueRecords(2_100).length, 1);
});

test("failed, interrupted, cancelled, and duplicate completions cannot create a new deadline", async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = new MediaSessionAutoArchiveStore(filePath, { idleMs: 100 });
  track(store, { now: 1_000 });

  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-failed",
    successful: false,
    now: 1_100,
  });
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-failed",
    now: 1_150,
  });
  assert.equal(store.dueRecords(10_000).length, 0);

  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-1",
    now: 1_200,
  });
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-1",
    now: 1_250,
  });
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }).completedAt, 1_200);

  store.cancel({ hostId: "personal", sessionId: firstSessionId });
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-1",
    now: 5_000,
  });
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }).completedAt, null);
  assert.equal(store.dueRecords(10_000).length, 0);
});

test("persists minimal private records across restarts and isolates hosts", async (t) => {
  const { filePath } = await temporaryStore(t);
  const secretPrompt = "帮我提取 https://v.douyin.com/private-token/ 并保存，口令 secret-value";
  const store = new MediaSessionAutoArchiveStore(filePath, { idleMs: 100 });
  store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: secretPrompt,
    isFirstPrompt: true,
    now: 1_000,
  });
  store.recordPrompt({
    hostId: "company",
    sessionId: firstSessionId,
    text: "https://xhslink.cn/abc",
    isFirstPrompt: true,
    now: 2_000,
  });
  store.recordCompletion({
    hostId: "personal",
    sessionId: firstSessionId,
    turnId: "turn-personal",
    now: 1_100,
  });

  const restarted = new MediaSessionAutoArchiveStore(filePath, { idleMs: 100 });
  assert.equal(restarted.get({ hostId: "personal", sessionId: firstSessionId }).kind, "douyin");
  assert.equal(restarted.get({ hostId: "company", sessionId: firstSessionId }).kind, "xiaohongshu");
  assert.equal(restarted.dueRecords(1_200).length, 1);

  const persisted = await fs.readFile(filePath, "utf8");
  assert.equal(persisted.includes("private-token"), false);
  assert.equal(persisted.includes("secret-value"), false);
  assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("non-media first prompts remain untracked and tracked categories survive later prompts", async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = new MediaSessionAutoArchiveStore(filePath);
  assert.equal(store.recordPrompt({
    hostId: "personal",
    sessionId: secondSessionId,
    text: "分析一下本周计划",
    isFirstPrompt: true,
    now: 1_000,
  }), null);
  assert.equal(store.recordCompletion({
    hostId: "personal",
    sessionId: secondSessionId,
    turnId: "turn-untracked",
    now: 1_100,
  }), null);

  track(store, { now: 2_000 });
  store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: "普通 follow-up",
    now: 2_500,
  });
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }).kind, "douyin");
  assert.equal(store.get({ hostId: "personal", sessionId: firstSessionId }).lastUserMessageAt, 2_500);
});

test("rejects invalid host and Session identifiers", async (t) => {
  const { filePath } = await temporaryStore(t);
  const store = new MediaSessionAutoArchiveStore(filePath);
  assert.equal(store.get({
    hostId: "personal",
    sessionId: "11111111-1111-1111-1111-111111111111",
  }), null);
  assert.throws(() => store.get({ hostId: "../personal", sessionId: firstSessionId }), /host ID is invalid/);
  assert.throws(() => store.get({ hostId: "personal", sessionId: "../session" }), /Session ID is invalid/);
});

function track(store, { now }) {
  return store.recordPrompt({
    hostId: "personal",
    sessionId: firstSessionId,
    text: "https://v.douyin.com/abc/",
    isFirstPrompt: true,
    now,
  });
}

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-auto-archive-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, filePath: path.join(directory, "state", "auto-archive.json") };
}
