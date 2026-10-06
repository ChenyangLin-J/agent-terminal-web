import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebSessionAdapter } from '../public/platform-agent-web-adapter.js';

const turnId = '019f8d05-7a2d-7f43-a52d-000000000012';
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
  const oldFetch = globalThis.fetch;
  const adapter = createAgentWebSessionAdapter({ clientId: 'lazy-history' });
  const calls = []; let active = false, fail = false, deferred = null;
  globalThis.fetch = async raw => {
    const url = new URL(raw, 'http://test.invalid'); calls.push(url.pathname);
    if (url.pathname.startsWith('/api/session-preview/')) {
      if (deferred) await deferred;
      return Response.json({ active, conversation: { turns: [{ id: turnId, user: 'question', assistant: [{ text: 'answer', phase: 'final_answer' }] }] } });
    }
    if (url.pathname.includes('/process/')) {
      if (fail) return Response.json({ error: 'read failed' }, { status: 500 });
      return Response.json({ items: [{ id: 'command', type: 'command', text: 'run', turnId }] });
    }
    if (url.pathname.endsWith('/viewed') || url.pathname === '/api/platform/session-metadata') return Response.json({});
    throw new Error(`Unexpected request ${raw}`);
  };
  t.after(() => { adapter.dispose(); globalThis.fetch = oldFetch; });
  return { adapter, calls, setActive(value) { active = value; }, setFail(value) { fail = value; }, defer(value) { deferred = value; } };
}

test('process cache is checked before session reads, coalesces concurrent loads and retries failures', async t => {
  const { adapter, calls, setFail } = fixture(t);
  const id = 'history:thread';
  await adapter.readSession(id);
  let snapshot = await adapter.readSession(id);
  const stop = adapter.subscribeSession(id, { onEvent: event => { snapshot = adapter.applyEvent(snapshot, event); } });
  const before = calls.length;
  const result = await Promise.all([adapter.execute(id, 'loadTechnicalDetails', { turnId }), adapter.execute(id, 'loadTechnicalDetails', { turnId })]);
  assert.equal(calls.length, before + 1);
  assert.equal(result[0].items.length, 1);
  assert.deepEqual(snapshot.technicalDetailsLoaded, [turnId]);
  await adapter.execute(id, 'loadTechnicalDetails', { turnId });
  await adapter.markResultRead(id, turnId);
  assert.equal(calls.length, before + 2, 'reopen makes no request; marking read only makes its POST');
  setFail(true);
  await assert.rejects(adapter.execute(id, 'loadTechnicalDetails', { turnId: 'other' }), /read failed/);
  setFail(false);
  await adapter.execute(id, 'loadTechnicalDetails', { turnId: 'other' });
  assert.equal(calls.filter(url => url.endsWith('/process/other')).length, 2);
  stop();
});

test('completed history stops polling; active history updates without overlap and pauses when hidden', async t => {
  const { adapter, calls, setActive, defer } = fixture(t);
  const id = 'history:thread';
  const document = new EventTarget(); document.visibilityState = 'visible';
  const windowEvents = new EventTarget();
  const originals = ['document', 'addEventListener', 'removeEventListener'].map(key => [key, globalThis[key]]);
  Object.assign(globalThis, { document, addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents) });
  t.after(() => originals.forEach(([key, value]) => { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }));
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  await adapter.readSession(id);
  const events = [];
  const stop = adapter.subscribeSession(id, { onEvent: event => events.push(event) });
  const reads = () => calls.filter(url => url.includes('/session-preview/')).length;
  t.mock.timers.tick(15000); await settle();
  assert.equal(reads(), 1);
  setActive(true);
  windowEvents.dispatchEvent(new Event('focus')); await settle();
  assert.equal(reads(), 2);
  let resolve; defer(new Promise(done => { resolve = done; }));
  t.mock.timers.tick(5000); await settle();
  assert.equal(reads(), 3);
  t.mock.timers.tick(15000); windowEvents.dispatchEvent(new Event('focus')); await settle();
  assert.equal(reads(), 3, 'slow poll and focus share the pending read');
  resolve(); defer(null); await settle();
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(15000); await settle(); assert.equal(reads(), 3);
  setActive(false); document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await settle();
  assert.equal(reads(), 4);
  t.mock.timers.tick(15000); await settle(); assert.equal(reads(), 4);
  assert.equal(events.length, 3);
  stop();
  windowEvents.dispatchEvent(new Event('focus')); t.mock.timers.tick(15000); await settle(); assert.equal(reads(), 4);
});
