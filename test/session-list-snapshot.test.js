import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionListSnapshot } from '../lib/session-list-snapshot.js';
import { readThreadCatalogWindow } from '../lib/thread-catalog-window.js';

test('catalogue snapshots read each store once, lazily, and never cache between requests', async () => {
  const counts = { settings: 0, titles: 0, archive: 0, favorites: 0, records: 0 };
  const readers = Object.fromEntries(Object.keys(counts).map(name => [name, () => {
    counts[name]++;
    const value = { revision: counts[name] };
    return name === 'titles' ? Promise.resolve(value) : value;
  }]));
  const first = createSessionListSnapshot(readers);
  assert.deepEqual(Object.values(counts), [0, 0, 0, 0, 0]);
  for (let i = 0; i < 58; i++) {
    for (const name of Object.keys(counts)) assert.equal(first[name], first[name]);
  }
  await first.titles;
  assert.deepEqual(Object.values(counts), [1, 1, 1, 1, 1]);
  const second = createSessionListSnapshot(readers);
  assert.equal(second.settings.revision, 2);
  assert.equal(first.settings.revision, 1);
  assert.equal(counts.titles, 1);
});

test('snapshots propagate damaged-file and other reader failures', () => {
  const damage = new Error('damaged authoritative state');
  const snapshot = createSessionListSnapshot({ settings() { throw damage; } });
  assert.throws(() => snapshot.settings, error => error === damage);
});

test('metadata windows extend native pages only as needed and account for hidden archived rows', async () => {
  const calls = [];
  const first = { data: Array.from({ length: 40 }, (_, i) => ({ id: `thread-${i}` })), nextCursor: '40' };
  const readPage = async params => {
    calls.push(params);
    const start = Number(params.cursor);
    return { data: Array.from({ length: params.limit }, (_, i) => ({ id: `thread-${start + i}` })), nextCursor: String(start + params.limit) };
  };
  assert.equal((await readThreadCatalogWindow(first, { limit: 21, readPage })).length, 21);
  assert.deepEqual(calls, []);
  const rows = await readThreadCatalogWindow(first, { limit: 41, readPage, include: row => !['thread-0', 'thread-40'].includes(row.id) });
  assert.equal(rows.length, 41);
  assert.equal(rows.at(-1).id, 'thread-42');
  assert.deepEqual(calls, [{ cursor: '40', limit: 2 }, { cursor: '42', limit: 1 }]);
});

test('metadata windows terminate at end or repeated cursors without duplicating rows', async () => {
  let reads = 0;
  const rows = await readThreadCatalogWindow({ data: [{ id: 'one' }], nextCursor: 'again' }, {
    limit: 21,
    readPage: async () => { reads++; return { data: [{ id: 'one' }, { id: 'two' }], nextCursor: 'again' }; },
  });
  assert.deepEqual(rows.map(row => row.id), ['one', 'two']);
  assert.equal(reads, 1);
});
