import assert from 'node:assert/strict';
import test from 'node:test';
import { catalogueSummary, createPlatformSessionEvents } from '../lib/platform-session-events.js';

test('catalogue broadcaster exposes only summary metadata and replays ordered events', (t) => {
  const routes = new Map();
  const app = { get: (path, handler) => routes.set(path, handler) };
  const stream = createPlatformSessionEvents({ heartbeatMs: 60_000, eventLimit: 4, instanceId: 'test-instance' });
  stream.register(app);
  t.after(() => stream.close());
  const first = stream.broadcast({
    id: 'web-b', sessionId: 'thread-b', title: 'B', lastActivityAt: '2026-10-06T08:00:00Z',
    sessionRevision: 4, tokenUsage: { secret: 'not catalogue metadata' }, accessToken: 'never',
    turnState: { active: true, turnId: 'turn-b', requirements: [{ text: 'private prompt' }] },
  });
  stream.broadcast({ id: 'web-b', sessionId: 'thread-b', title: 'B', lastActivityAt: '2026-10-06T08:01:00Z', sessionRevision: 5, hasUnreadResult: true, turnState: { active: false, turnId: 'turn-b' } });
  assert.equal(first.summary.turnState.active, true);
  assert.equal(first.summary.turnState.requirements, undefined);
  assert.equal(first.summary.tokenUsage, undefined);
  assert.equal(first.summary.accessToken, undefined);

  const output = [];
  let closed;
  routes.get('/api/platform/session-events')(
    { query: { after: '1' }, headers: {}, on: (name, callback) => { if (name === 'close') closed = callback; } },
    { set() {}, flushHeaders() {}, write: (value) => output.push(value), end() {} },
  );
  assert.equal(stream.clientCount, 1);
  assert.equal(output.some((value) => value.includes('id: 1')), false);
  assert.equal(output.some((value) => value.includes('id: 2')), true);
  assert.equal(output.some((value) => value.includes('event: ready')), true);
  closed();
  assert.equal(stream.clientCount, 0);
});

test('catalogue stream reports a replay gap after its bounded buffer rolls over', (t) => {
  const routes = new Map();
  const app = { get: (path, handler) => routes.set(path, handler) };
  const stream = createPlatformSessionEvents({ heartbeatMs: 60_000, eventLimit: 1 });
  stream.register(app); t.after(() => stream.close());
  stream.broadcast({ id: 'one', sessionId: 'thread-one' });
  stream.broadcast({ id: 'two', sessionId: 'thread-two' });
  const output = [];
  routes.get('/api/platform/session-events')(
    { query: { after: '0' }, headers: { 'last-event-id': '0' }, on() {} },
    { set() {}, flushHeaders() {}, write: (value) => output.push(value), end() {} },
  );
  assert.equal(output.some((value) => value.includes('event: replay-gap')), false, 'a fresh client receives the retained catalogue tail');
  const gap = [];
  routes.get('/api/platform/session-events')(
    { query: { after: '1' }, headers: {}, on() {} },
    { set() {}, flushHeaders() {}, write: (value) => gap.push(value), end() {} },
  );
  assert.equal(gap.some((value) => value.includes('event: replay-gap')), false, 'event 2 can still continue cursor 1');
  stream.broadcast({ id: 'three', sessionId: 'thread-three' });
  const stale = [];
  routes.get('/api/platform/session-events')(
    { query: { after: '1' }, headers: {}, on() {} },
    { set() {}, flushHeaders() {}, write: (value) => stale.push(value), end() {} },
  );
  assert.equal(stale.some((value) => value.includes('snapshotRequired')), true);
});

test('historical catalogue timestamps are normalized and invalid values are omitted', () => {
  assert.deepEqual(catalogueSummary({ id: 'history:a', sessionId: 'a', updatedAt: 'bad' }), {
    id: 'history:a', sessionId: 'a', threadId: 'a', archived: false, favorited: false,
    released: false, ready: true, pendingServerRequestCount: 0, hasUnreadResult: false,
    sessionRevision: 0,
  });
});
