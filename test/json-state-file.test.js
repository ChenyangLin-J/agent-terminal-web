import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";


import {
  createSessionTitleService,
  createSyncObjectStateStore,
  updateLiveSessionTitle,
} from "../lib/agent-session-state.js";
import {
  readJsonFile,
  readJsonFileSync,
  writeJsonFileAtomic,
  writeJsonFileAtomicSync,
} from "../lib/json-state-file.js";

test('same-session title updates serialize native and live effects as well as file writes', async () => {
  const titles = {};
  const titleService = { set: async (id, title) => { titles[id] = title; } };
  const live = [{ sessionId: 'native', title: 'original' }];
  let entered, finish;
  const started = new Promise(resolve => { entered = resolve; });
  const nativeCalls = [];
  const options = {
    titleService, sessionId: 'native', resolveFallbackTitle: async () => 'original',
    liveSessions: () => live, persist: () => {}, broadcast: () => {},
    saveNativeName: async (_id, title) => {
      nativeCalls.push(title);
      if (title === 'first') await new Promise(resolve => { finish = resolve; entered(); });
      return true;
    },
  };
  const first = updateLiveSessionTitle({ ...options, title: 'first' });
  await started;
  const second = updateLiveSessionTitle({ ...options, title: 'second' });
  await Promise.resolve();assert.deepEqual(nativeCalls, ['first']);
  finish();await Promise.all([first, second]);
  assert.deepEqual(nativeCalls, ['first', 'second']);
  assert.equal(titles.native, 'second');assert.equal(live[0].title, 'second');
});

test("JSON state only treats a missing file as empty and keeps damaged bytes intact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-json-state-"));
  const file = path.join(root, "state.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.deepEqual(readJsonFileSync(file, { missingValue: () => ({}) }), {});
  assert.deepEqual(await readJsonFile(file, { missingValue: () => ({}) }), {});

  await writeFile(file, "{ damaged");
  assert.throws(() => readJsonFileSync(file, { missingValue: () => ({}) }), /parse failed/);
  await assert.rejects(readJsonFile(file, { missingValue: () => ({}) }), /parse failed/);
  assert.equal(await readFile(file, "utf8"), "{ damaged");

  await writeFile(file, "[]\n");
  await assert.rejects(
    readJsonFile(file, {
      missingValue: () => ({}),
      validate: (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    }),
    /validate failed/,
  );
});

test("atomic JSON writers use private files and replace the complete document", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-json-write-"));
  const syncFile = path.join(root, "sync", "state.json");
  const asyncFile = path.join(root, "async", "state.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  writeJsonFileAtomicSync(syncFile, { first: true });
  await writeJsonFileAtomic(asyncFile, { second: true });

  assert.deepEqual(JSON.parse(await readFile(syncFile, "utf8")), { first: true });
  assert.deepEqual(JSON.parse(await readFile(asyncFile, "utf8")), { second: true });
  assert.equal((await stat(syncFile)).mode & 0o777, 0o600);
  assert.equal((await stat(asyncFile)).mode & 0o777, 0o600);
});

test("Session title mutations are serialized so concurrent updates keep both sessions", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-title-state-"));
  const file = path.join(root, "session-titles.json");
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = createSessionTitleService({
    filePath: file,
    isValidSessionId: (value) => /^thread-[ab]$/.test(value),
    normalizeTitle: (value) => String(value || "").trim(),
  });

  await Promise.all([
    service.set("thread-a", "Alpha"),
    service.set("thread-b", "Beta"),
  ]);
  assert.deepEqual(await service.read(), {
    "thread-a": "Alpha",
    "thread-b": "Beta",
  });

  await service.set("thread-a", "");
  assert.deepEqual(await service.read(), { "thread-b": "Beta" });
});

test("product object and title stores refuse to mutate damaged state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-product-state-corrupt-"));
  const objectFile = path.join(root, "settings.json");
  const titleFile = path.join(root, "titles.json");
  const damaged = "{ incomplete\n";
  await Promise.all([writeFile(objectFile, damaged), writeFile(titleFile, damaged)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const objectStore = createSyncObjectStateStore({
    filePath: objectFile,
    label: "Settings",
    normalize: (value) => value,
  });
  assert.throws(() => objectStore.update((value) => { value.added = true; }), /parse failed/);

  const titleService = createSessionTitleService({
    filePath: titleFile,
    isValidSessionId: () => true,
    normalizeTitle: String,
  });
  await assert.rejects(titleService.set("thread-a", "Replacement"), /parse failed/);
  assert.equal(await readFile(objectFile, "utf8"), damaged);
  assert.equal(await readFile(titleFile, "utf8"), damaged);
});

test("clearing a custom title updates every live attachment to the generated title", async () => {
  const calls = [];
  const sessions = [
    { id: "web-a", sessionId: "thread-a", title: "Custom" },
    { id: "web-b", sessionId: "thread-a", title: "Custom" },
    { id: "web-c", sessionId: "thread-b", title: "Other" },
  ];
  const result = await updateLiveSessionTitle({
    titleService: { set: async (...args) => calls.push(["set", ...args]) },
    sessionId: "thread-a",
    title: "",
    resolveFallbackTitle: async () => "Generated prompt",
    saveNativeName: async (...args) => {
      calls.push(["native", ...args]);
      return true;
    },
    liveSessions: () => sessions,
    persist: (session) => calls.push(["persist", session.id]),
    broadcast: (session) => calls.push(["broadcast", session.id]),
  });

  assert.deepEqual(result, { customTitle: "", nativeNameSaved: true });
  assert.deepEqual(sessions.map((session) => session.title), [
    "Generated prompt",
    "Generated prompt",
    "Other",
  ]);
  assert.deepEqual(calls, [
    ["set", "thread-a", ""],
    ["native", "thread-a", ""],
    ["persist", "web-a"],
    ["broadcast", "web-a"],
    ["persist", "web-b"],
    ["broadcast", "web-b"],
  ]);
});
