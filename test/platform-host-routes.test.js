import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerPlatformSessionRoutes } from '../lib/platform-session-routes.js';

async function fixture(t) {
  const sessions = new Map();
  let created = 0, cancelled = 0;
  const host = {
    sessions, records: () => ({}), restore: () => null, findReusable: () => null,
    resolvePath: value => value, access: value => value, title: value => value, purpose: value => value,
    create(cwd, launch) {
      const session = { id: `web-${++created}`, cwd, sessionId: `thread-${created}`, title: launch.title, ready: true, turnState: { active: false, queuedTurns: [{ id: 'queued-a', text: 'later' }] }, appServer: { cancelQueuedTurn() { cancelled++; } } };
      sessions.set(session.id, session); return session;
    },
    snapshot: session => ({ session: { id: session.id, sessionId: session.sessionId }, revision: 1 }),
    persist() {}, broadcast() {}, status: async () => ({}), models: async () => ({}),
    validThread: value => value === 'thread-a', validTurn: value => value === 'turn-a',
    readProcess: async (session, turnId) => [{ id: 'command-a', type: 'command', text: `${session.sessionId}/${turnId}` }],
    listWebSessions: () => [...sessions.values()], listCodexSessions: async () => [], searchSessions: async () => [], favoriteIds: () => new Set(),
  };
  const app = express(); app.use(express.json()); registerPlatformSessionRoutes(app, host);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const request = async (pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    return { status: response.status, body: await response.json() };
  };
  return { request, host, origin: `http://127.0.0.1:${server.address().port}`, counts: () => ({ created, cancelled }) };
}

test('selected JSON negotiates gzip, retains UTF-8 data and private no-store, and honors identity', async t => {
  const { host, origin } = await fixture(t);
  const live = host.create('.', { title: 'A' });
  const value = { session: { id: live.id }, transcript: { items: [{ type: 'assistant', phase: 'final_answer', text: '这是完整的正文。'.repeat(5000) }] } };
  host.snapshot = () => value;
  let timing;
  host.logSnapshot = value => { timing = value; };
  for (const encoding of ['gzip', 'identity', 'gzip;q=0, identity']) {
    const response = await fetch(`${origin}/api/platform/sessions/${live.id}`, { headers: { 'Accept-Encoding': encoding } });
    assert.deepEqual(await response.json(), value);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.match(response.headers.get('Vary'), /Accept-Encoding/);
    assert.equal(Number(response.headers.get('X-Agent-Snapshot-Bytes')), Buffer.byteLength(JSON.stringify(value)));
    if (encoding === 'gzip') {
      assert.equal(response.headers.get('Content-Encoding'), 'gzip');
      assert.ok(timing.encodedBytes < timing.bytes / 10);
    } else assert.equal(response.headers.get('Content-Encoding'), null);
  }
});

test('create and queue cancellation replay receipts without repeating their side effects', async t => {
  const { request, counts } = await fixture(t);
  const payload = { title: 'A', idempotencyKey: 'create-operation-a' };
  const first = await request('/api/platform/sessions', payload);
  const repeated = await request('/api/platform/sessions', payload);
  assert.equal(first.body.session.id, repeated.body.session.id);
  assert.equal(counts().created, 1);
  assert.equal((await request('/api/platform/sessions', { ...payload, title: 'B' })).status, 409);
  const queued = { queuedTurnId: 'queued-a', idempotencyKey: 'cancel-operation-a' };
  assert.equal((await request('/api/platform/sessions/web-1/actions/deleteQueuedTurn', queued)).status, 200);
  assert.equal((await request('/api/platform/sessions/web-1/actions/deleteQueuedTurn', queued)).status, 200);
  assert.equal(counts().cancelled, 1);
  assert.equal((await request('/api/platform/sessions/web-1/actions/deleteQueuedTurn', { ...queued, queuedTurnId: 'different' })).status, 409);
});

test('live full-text search finds message bodies and rejects invalid paging', async t => {
  const { request, host } = await fixture(t);
  const session = host.create('.', { title: 'A' });
  session.appTranscript = [{ type: 'assistant', text: 'unique body phrase' }];
  assert.equal((await request('/api/platform/sessions?q=unique%20body')).body.sessions.length, 1);
  assert.equal((await request('/api/platform/sessions?q=missing')).body.sessions.length, 0);
  assert.equal((await request('/api/platform/sessions?cursor=-1')).status, 400);
});

test('bounded catalogue paging retains the default contract, ordering and favorites', async t => {
  const { request, host } = await fixture(t);
  const rows = Array.from({ length: 67 }, (_, i) => ({ id: `thread-${i}`, title: `History ${i}`, updatedAt: new Date(Date.UTC(2026, 9, 9) - i * 1000).toISOString() }));
  const limits = [];
  host.listCodexSessions = async options => { limits.push(options.limit); return rows.slice(0, options.limit); };
  host.favoriteIds = () => new Set(['thread-21']);
  const legacy = await request('/api/platform/sessions');
  assert.equal(legacy.body.sessions.length, 50);
  assert.equal(legacy.body.nextCursor, '50');
  assert.equal(limits[0], undefined);
  const pages = [];
  let cursor = '0';
  do {
    const response = await request(`/api/platform/sessions?limit=20&cursor=${cursor}`);
    assert.equal(response.status, 200);
    assert.ok(response.body.sessions.length <= 20);
    pages.push(...response.body.sessions);
    cursor = response.body.nextCursor;
  } while (cursor);
  assert.deepEqual(pages.map(row => row.threadId), rows.map(row => row.id));
  assert.equal(pages[21].favorited, true);
  assert.ok(pages.every(row => row.reference?.threadId === row.threadId));
  for (const invalid of ['', '0', '-1', '51', '1.5', 'abc']) {
    assert.equal((await request(`/api/platform/sessions?limit=${invalid}`)).status, 400);
  }
  assert.deepEqual((await request('/api/platform/sessions?limit=20&cursor=100')).body, { sessions: [], nextCursor: null });
});

test('one request snapshot is passed through all catalogue projections and refreshed on the next request', async t => {
  const { request, host } = await fixture(t);
  let reads = 0;
  const seen = [];
  host.listSnapshot = () => ({ request: ++reads });
  host.archiveIds = snapshot => { seen.push(snapshot); return new Set(); };
  host.listWebSessions = snapshot => { seen.push(snapshot); return []; };
  host.listCodexSessions = async (_, snapshot) => { seen.push(snapshot); return []; };
  host.favoriteIds = snapshot => { seen.push(snapshot); return new Set(); };
  await request('/api/platform/sessions?archived=1&limit=20');
  assert.equal(reads, 1);
  assert.equal(seen.length, 5);
  assert.ok(seen.every(snapshot => snapshot === seen[0]));
  const first = seen[0]; seen.length = 0;
  host.searchSessions = async (_, snapshot) => { seen.push(snapshot); return []; };
  await request('/api/platform/sessions?q=search&limit=20');
  assert.equal(reads, 2);
  assert.ok(seen.every(snapshot => snapshot === seen[0] && snapshot !== first));
});

test('the catalog keeps the live attachment over older released records for the same thread', async t => {
  const { request, host } = await fixture(t);
  const live = { id: 'live', sessionId: 'thread-a', title: 'Existing', lastActivityAt: '2026-10-05T06:26:00Z', turnState: { active: true } };
  const old = { ...live, id: 'old', released: true, lastActivityAt: '2026-10-05T02:36:00Z', turnState: { active: false } };
  const older = { ...old, id: 'older', lastActivityAt: '2026-10-04T02:36:00Z' };
  host.listCodexSessions = async () => [{ id: 'thread-a', title: 'Existing' }];
  for (const values of [[live, old, older], [older, old, live]]) {
    host.listWebSessions = () => values;
    const result = await request('/api/platform/sessions');
    assert.equal(result.body.sessions.length, 1);
    assert.equal(result.body.sessions[0].id, live.id);
    assert.equal(result.body.sessions[0].turnState.active, true);
  }
  host.listWebSessions = () => [old, older];
  assert.equal((await request('/api/platform/sessions')).body.sessions[0].id, old.id);
});

test('reading historical process does not allocate a live Session and validates identities', async t => {
 const {request,counts}=await fixture(t);
 const result=await request('/api/platform/threads/thread-a/process/turn-a');
 assert.equal(result.status,200);assert.equal(result.body.items[0].text,'thread-a/turn-a');
 assert.equal(counts().created,0);
 assert.equal((await request('/api/platform/threads/invalid/process/turn-a')).status,400);
});

test('locally archived live rows are hidden, including historical merges, until archive search is enabled', async t => {
  const { request, host } = await fixture(t);
  const live = host.create('.', { title: 'Archived still running' });
  host.archiveIds = () => new Set([live.sessionId]);
  host.listCodexSessions = async () => [{ id: live.sessionId, title: live.title }];
  host.searchSessions = async () => [{ session: { id: live.sessionId, title: live.title } }];
  assert.deepEqual((await request('/api/platform/sessions')).body.sessions, []);
  assert.deepEqual((await request('/api/platform/sessions?q=Archived')).body.sessions, []);
  const result = await request('/api/platform/sessions?q=Archived&archived=1');
  assert.equal(result.body.sessions.length, 1);
  assert.equal(result.body.sessions[0].archived, true);
  assert.equal(result.body.sessions[0].id, live.id);
});

test('metadata does not create a Session; context uses the narrow read and failed profile setters retry', async t => {
  const { request, host, counts } = await fixture(t);
  host.metadata = async cwd => ({ cwd, currentModel: 'gpt-6.1-sol', currentReasoningEffort: 'xhigh' });
  const metadata = await request('/api/platform/session-metadata?cwd=project');
  assert.equal(metadata.body.currentReasoningEffort, 'xhigh');
  assert.equal(counts().created, 0);
  const live = host.create('.', { title: 'A' });
  host.status = () => { throw new Error('expensive account bundle must not run'); };
  host.context = async () => ({ tokenUsage: { contextUsedTokens: 1234, modelContextWindow: 200000 } });
  assert.equal((await request(`/api/platform/sessions/${live.id}/actions/readContext`)).body.tokenUsage.contextUsedTokens, 1234);
  let failed = true;
  host.models = async session => { if (failed) throw new Error('temporary catalog failure'); session.appModel = 'gpt-6.1-sol'; };
  host.access = value => value === 'full' ? 'full' : 'safe';
  const payload = { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh', accessMode: 'restricted', serviceTier: 'priority', idempotencyKey: 'profile-operation-a' };
  assert.equal((await request(`/api/platform/sessions/${live.id}/actions/executionProfile`, payload)).status, 409);
  failed = false;
  const result = await request(`/api/platform/sessions/${live.id}/actions/executionProfile`, payload);
  assert.equal(result.status, 200); assert.equal(live.access, 'safe'); assert.equal(live.appServiceTier, 'priority');
});
