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
