import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebSessionAdapter } from '../public/platform-agent-web-adapter.js';
import { watchAgentWebCatalog } from '../public/platform-agent-web-catalog.js';

test('A stays selected while B completion updates, and duplicate or stale events cannot roll B back', async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (raw) => {
    const url = new URL(raw, 'http://test.invalid');
    if (url.pathname === '/api/platform/sessions') return Response.json({ sessions: [
      session('web-a', 'thread-a', 3, true, 'turn-a', '2026-10-06T08:00:00Z'),
      session('web-b', 'thread-b', 7, true, 'turn-new', '2026-10-06T07:00:00Z'),
    ] });
    throw new Error(`Unexpected fetch ${raw}`);
  };
  const adapter = createAgentWebSessionAdapter({ clientId: 'catalog-test' });
  t.after(() => { adapter.dispose(); globalThis.fetch = originalFetch; });
  let rows = (await adapter.listSessions()).sessions;
  const selected = 'web-a';
  rows = adapter.applyCatalogEvent(rows, { type: 'session-summary', sessionId: 'web-b', revision: 8, turnId: 'turn-new', summary: session('web-b', 'thread-b', 8, false, 'turn-new', '2026-10-06T08:05:00Z', true) });
  assert.equal(selected, 'web-a');
  assert.equal(rows.find((item) => item.id === 'web-b').status, 'unread');
  assert.equal(rows[0].id, 'web-b', 'new activity keeps timestamp ordering');
  const completed = rows;
  rows = adapter.applyCatalogEvent(rows, { type: 'session-summary', sessionId: 'web-b', revision: 8, summary: session('web-b', 'thread-b', 8, false, 'turn-new', '2026-10-06T08:05:00Z', true) });
  assert.equal(rows, completed, 'duplicate revisions are ignored');
  rows = adapter.applyCatalogEvent(rows, { type: 'session-summary', sessionId: 'web-b', revision: 6, summary: session('web-b', 'thread-b', 6, false, 'turn-old', '2026-10-06T08:06:00Z', true) });
  assert.equal(rows, completed, 'out-of-order revisions are ignored even with a later timestamp');

  const active = [{ ...completed[0], status: 'running', sessionRevision: undefined, outputRevision: undefined, turnState: { active: true, turnId: 'turn-latest' } }, completed[1]];
  const guarded = adapter.applyCatalogEvent(active, { type: 'session-summary', sessionId: 'web-b', summary: session('web-b', 'thread-b', undefined, false, 'turn-old', '2026-10-06T08:07:00Z', true) });
  assert.equal(guarded, active, 'an old completion cannot overwrite a newer active turn without revisions');
});

test('catalog watcher closes while hidden, reconnects from its cursor, reconciles summaries, and never reads a transcript', async () => {
  const listeners = new Map();
  const windowObject = eventTarget();
  const documentObject = { ...eventTarget(), visibilityState: 'visible' };
  const sources = [];
  class Source {
    listeners = new Map(); closed = false;
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    close() { this.closed = true; }
    emit(name, value = {}) { this.listeners.get(name)?.(value); }
  }
  let rows = [session('web-a', 'thread-a', 1, true, 'turn-a', '2026-10-06T08:00:00Z'), session('web-b', 'thread-b', 1, true, 'turn-b', '2026-10-06T07:00:00Z')];
  let reconciles = 0;
  const controller = {
    getSnapshot: () => ({ selectedId: 'web-a', sessions: rows }),
    updateSessions: (value) => { rows = typeof value === 'function' ? value(rows) : value; },
  };
  const adapter = {
    applyCatalogEvent: (current, event) => current.map((item) => item.id === event.sessionId ? { ...item, ...event.summary } : item),
    reconcileCatalog: async (current, { signal }) => { listeners.set('signal', signal); reconciles += 1; return current; },
    readSession: () => { throw new Error('full history must not be read'); },
    subscribeSession: () => { throw new Error('runtime must not be attached'); },
  };
  const cleanup = watchAgentWebCatalog({ controller, adapter, createEventSource: (url) => new Source(url), window: windowObject, document: documentObject });
  assert.equal(sources.length, 1);
  sources[0].emit('session-summary', { lastEventId: '12', data: JSON.stringify({ type: 'session-summary', sessionId: 'web-b', summary: { status: 'unread' } }) });
  assert.equal(rows.find((item) => item.id === 'web-b').status, 'unread');
  documentObject.visibilityState = 'hidden'; documentObject.dispatch('visibilitychange');
  assert.equal(sources[0].closed, true);
  documentObject.visibilityState = 'visible'; documentObject.dispatch('visibilitychange');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sources[1].url, '/api/platform/session-events?after=12');
  assert.equal(reconciles, 1);
  cleanup();
  assert.equal(sources[1].closed, true);
});

test('focus reconciliation uses catalogue pages only and preserves display aliases and loaded rows', async t => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (raw) => {
    calls.push(String(raw));
    const url = new URL(raw, 'http://test.invalid');
    if (url.pathname !== '/api/platform/sessions') throw new Error(`Unexpected fetch ${raw}`);
    return Response.json({ sessions: [session('target-b', 'thread-b', 4, false, 'turn-b', '2026-10-06T09:00:00Z', true)], nextCursor: null });
  };
  const storage = globalThis.sessionStorage;
  const values = new Map([['agent-web.session-aliases', JSON.stringify([['alias-b', 'target-b']])]]);
  globalThis.sessionStorage = { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const adapter = createAgentWebSessionAdapter({ clientId: 'reconcile-test' });
  t.after(() => { adapter.dispose(); globalThis.fetch = originalFetch; if (storage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = storage; });
  const olderLoaded = { id: 'history:older', sessionId: 'older', threadId: 'older', title: 'Older', updatedAt: '2026-01-01T00:00:00Z', status: 'idle' };
  const result = await adapter.reconcileCatalog([{ id: 'alias-b', sessionId: 'thread-b', threadId: 'thread-b', status: 'running' }, olderLoaded]);
  assert.equal(result.find((item) => item.id === 'alias-b').status, 'unread');
  assert.equal(result.includes(olderLoaded), true, 'a row outside the current server page remains loaded');
  assert.equal(calls.every((value) => new URL(value, 'http://test.invalid').pathname === '/api/platform/sessions'), true);
});

test('a completion received while catalogue reconciliation is pending wins over its stale running response', async t => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const adapter = createAgentWebSessionAdapter({ clientId: 'reconcile-race-test' });
  t.after(() => { adapter.dispose(); globalThis.fetch = originalFetch; });
  const baseline = [session('web-b', 'thread-b', 7, true, 'turn-b', '2026-10-06T08:00:00Z')];
  let current = baseline;
  const pending = adapter.reconcileCatalog(baseline, { getCurrent: () => current });
  current = adapter.applyCatalogEvent(current, {
    type: 'session-summary', sessionId: 'web-b', revision: 8,
    summary: session('web-b', 'thread-b', 8, false, 'turn-b', '2026-10-06T08:01:00Z', true),
  });
  resolveFetch(Response.json({ sessions: [session('web-b', 'thread-b', 7, true, 'turn-b', '2026-10-06T08:00:00Z')], nextCursor: null }));
  const reconciled = await pending;
  assert.equal(reconciled[0].status, 'unread');
  assert.equal(reconciled[0].sessionRevision, 8);
});

test('a new server instance resets the SSE cursor domain, reconciles once, and accepts its first revision', async t => {
  const originalFetch = globalThis.fetch;
  let resolveFetch;
  globalThis.fetch = () => new Promise((resolve) => { resolveFetch = resolve; });
  const adapter = createAgentWebSessionAdapter({ clientId: 'restart-domain-test' });
  const windowObject = eventTarget();
  const documentObject = { ...eventTarget(), visibilityState: 'visible' };
  const sources = [];
  class Source {
    listeners = new Map();
    constructor(url) { this.url = url; sources.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name) { this.listeners.delete(name); }
    close() {}
    emit(name, value = {}) { this.listeners.get(name)?.(value); }
  }
  let rows = [session('web-b', 'thread-b', 90, true, 'old-turn', '2026-10-06T08:00:00Z')];
  const controller = {
    getSnapshot: () => ({ sessions: rows }),
    updateSessions: (value) => { rows = typeof value === 'function' ? value(rows) : value; },
  };
  const cleanup = watchAgentWebCatalog({ controller, adapter, createEventSource: (url) => new Source(url), window: windowObject, document: documentObject });
  t.after(() => { cleanup(); adapter.dispose(); globalThis.fetch = originalFetch; });
  sources[0].emit('ready', { data: JSON.stringify({ type: 'ready', instanceId: 'old', lastEventId: 90 }) });
  sources[0].emit('ready', { data: JSON.stringify({ type: 'ready', instanceId: 'new', lastEventId: 0 }) });
  assert.equal(rows[0].sessionRevision, undefined);
  sources[0].emit('session-summary', {
    lastEventId: '1',
    data: JSON.stringify({ type: 'session-summary', sessionId: 'web-b', revision: 1, summary: session('web-b', 'thread-b', 1, false, 'new-turn', '2026-10-06T08:02:00Z', true) }),
  });
  resolveFetch(Response.json({ sessions: [session('web-b', 'thread-b', undefined, true, 'old-turn', '2026-10-06T08:00:00Z')], nextCursor: null }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rows[0].status, 'unread');
  assert.equal(rows[0].sessionRevision, 1);
  documentObject.visibilityState = 'hidden'; documentObject.dispatch('visibilitychange');
  documentObject.visibilityState = 'visible'; documentObject.dispatch('visibilitychange');
  assert.equal(sources.at(-1).url, '/api/platform/session-events?after=1');
});

function session(id, threadId, revision, active, turnId, updatedAt, unread = false) {
  return { id, sessionId: threadId, threadId, title: id, sessionRevision: revision, lastActivityAt: updatedAt, updatedAt, hasUnreadResult: unread, turnState: { active, turnId } };
}

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
    dispatch: (name) => listeners.get(name)?.(),
  };
}
