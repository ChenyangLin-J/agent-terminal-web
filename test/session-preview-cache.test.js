import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractSessionConversationFromJsonl, extractSessionTokenUsageFromJsonl } from '../lib/session-preview.js';
import { writeHistoryProcessFixture } from '../scripts/testing/history-process-fixture.mjs';

test('unchanged conversation pages share parsing, including simultaneous reads; caller mutation cannot poison history', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-cache-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await writeHistoryProcessFixture(directory);
  const originalOpen = fs.open.bind(fs);
  let opens = 0;
  t.mock.method(fs, 'open', (...args) => { opens++; return originalOpen(...args); });
  const pages = await Promise.all([0, 1, 0].map(offset => extractSessionConversationFromJsonl(fixture.file, { limit: 1, offset })));
  assert.equal(opens, 2, 'one tail and one metadata head read across all pages');
  assert.equal(pages[0].turns[0].turnId, fixture.turnIds[1]);
  assert.equal(pages[1].turns[0].turnId, fixture.turnIds[0]);
  pages[0].turns[0].assistant[0].text = 'mutated';
  assert.notEqual((await extractSessionConversationFromJsonl(fixture.file, { limit: 1 })).turns[0].assistant[0].text, 'mutated');
  assert.equal(opens, 2);
  // Tail policy is part of the key, not whichever caller first read the file.
  await extractSessionConversationFromJsonl(fixture.file, { maxBytes: 65536 });
  assert.equal(opens, 4);
});

test('append, rewrite and atomic replacement invalidate both history and token usage', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-cache-version-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { file } = await writeHistoryProcessFixture(directory);
  await extractSessionConversationFromJsonl(file);
  assert.equal(await extractSessionTokenUsageFromJsonl(file), null);
  const record = (type, payload) => JSON.stringify({ timestamp: '2026-10-06T00:00:00Z', type, payload }) + '\n';
  await fs.appendFile(file, record('event_msg', { type: 'user_message', message: 'new appended user' }) + record('event_msg', { type: 'token_count', info: { total: { totalTokens: 123 } } }));
  assert.equal((await extractSessionConversationFromJsonl(file)).turns.at(-1).user, 'new appended user');
  assert.equal((await extractSessionTokenUsageFromJsonl(file)).total.totalTokens, 123);
  const replacement = file + '.replacement';
  const stat = await fs.stat(file);
  const rewritten = (await fs.readFile(file, 'utf8')).replace('new appended user', 'new replaced user');
  assert.equal(Buffer.byteLength(rewritten), stat.size);
  await fs.writeFile(replacement, rewritten);
  await fs.utimes(replacement, stat.atime, stat.mtime);
  await fs.rename(replacement, file);
  assert.equal((await extractSessionConversationFromJsonl(file)).turns.at(-1).user, 'new replaced user', 'inode replacement works even with same size and timestamp');
  await fs.writeFile(file, record('event_msg', { type: 'user_message', message: 'rewritten' }));
  assert.equal((await extractSessionConversationFromJsonl(file)).turns[0].user, 'rewritten');
  assert.equal(await extractSessionTokenUsageFromJsonl(file), null);
});

test('failed reads retry and bounded cache evicts old parsed files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'preview-cache-bound-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fixture = await writeHistoryProcessFixture(directory);
  const originalOpen = fs.open.bind(fs);
  let fail = true, opens = 0;
  t.mock.method(fs, 'open', (...args) => { opens++; if (fail) return Promise.reject(new Error('transient disk read')); return originalOpen(...args); });
  await assert.rejects(extractSessionConversationFromJsonl(fixture.file), /transient disk read/);
  fail = false;
  assert.equal((await extractSessionConversationFromJsonl(fixture.file)).turns.length, 2);
  for (let index = 0; index < 33; index++) {
    const file = path.join(directory, `extra-${index}.jsonl`);
    await fs.copyFile(fixture.file, file);
    await extractSessionConversationFromJsonl(file);
  }
  const before = opens;
  await extractSessionConversationFromJsonl(fixture.file);
  assert.equal(opens, before + 2, 'oldest file was evicted');
});
