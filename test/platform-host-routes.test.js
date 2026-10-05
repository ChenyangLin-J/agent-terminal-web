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
  return { request, host, counts: () => ({ created, cancelled }) };
}

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
