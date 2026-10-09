import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWebSessionAdapter } from '../public/platform-agent-web-adapter.js';

function fixture(t, fetch) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  const adapter = createAgentWebSessionAdapter({ clientId: 'transport-test', lazyMetadata: true });
  t.after(() => { adapter.dispose(); globalThis.fetch = original; });
  return adapter;
}

test('a transient GET failure recovers once without changing the selected conversation', async t => {
  let calls = 0;
  const adapter = fixture(t, async (_, options) => {
    assert.equal(options.redirect, 'manual');
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return Response.json({ session: { id: 'web-a', sessionId: 'native-a', ready: true }, transcript: { items: [{ id: 'answer', type: 'assistant', phase: 'final_answer', text: '保留正文' }] } });
  });
  const snapshot = await adapter.readSession('web-a');
  assert.equal(calls, 2);
  assert.equal(snapshot.threadId, 'native-a');
  assert.equal(snapshot.messages[0].content, '保留正文');
});

test('an interrupted response body is retried rather than accepted as an empty conversation', async t => {
  let calls = 0;
  const adapter = fixture(t, async () => ++calls === 1
    ? { ok: true, status: 200, json: async () => { throw new TypeError('terminated'); } }
    : Response.json({ sessions: [{ id: 'web-a', sessionId: 'native-a', title: '原会话' }] }));
  assert.equal((await adapter.listSessions()).sessions[0].title, '原会话');
  assert.equal(calls, 2);
});

test('persistent failures stop after two reads and malformed success never becomes empty history', async t => {
  let calls = 0;
  const adapter = fixture(t, async () => { calls++; return new Response('<html>bad response</html>'); });
  await assert.rejects(adapter.readSession('history:native-a'), error => error.transportFailure === 'invalid-response' && /服务响应异常/.test(error.message) && !error.knownResult);
  assert.equal(calls, 2);
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };
  await assert.rejects(adapter.listSessions(), error => error.transportFailure === 'network' && /网络连接中断/.test(error.message));
  assert.equal(calls, 4);
});

test('selection cancellation during retry backoff never performs the next read', async t => {
  const controller = new AbortController();
  let calls = 0;
  const adapter = fixture(t, async () => { calls++; setTimeout(() => controller.abort(), 10); throw new TypeError('Failed to fetch'); });
  await assert.rejects(adapter.listSessions({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
  await assert.rejects(adapter.listSessions({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('mutations are never automatically resent after an unknown transport result', async t => {
  let calls = 0;
  const adapter = fixture(t, async (_, options) => { calls++; assert.equal(options.method, 'POST'); throw new TypeError('Failed to fetch'); });
  await assert.rejects(adapter.createSession({ sessionId: 'native-a' }, { idempotencyKey: 'same-submission' }), error => !error.knownResult && error.transportFailure === 'network');
  assert.equal(calls, 1);
});

test('expired authentication is explicit, is not retried, and never produces empty history', async t => {
  let calls = 0;
  const adapter = fixture(t, async (_, options) => { calls++; assert.equal(options.redirect, 'manual'); return { type: 'opaqueredirect', status: 0 }; });
  await assert.rejects(adapter.readSession('history:native-a'), error => error.authRequired && /登录已过期/.test(error.message));
  assert.equal(calls, 1);
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'Not authenticated' }, { status: 401 }); };
  await assert.rejects(adapter.readSession('history:native-a'), error => error.status === 401 && /Not authenticated/.test(error.message));
  assert.equal(calls, 2);
});

test('explicit HTTP errors preserve status without retrying or treating permission denial as missing history', async t => {
  let status = 503, calls = 0;
  const adapter = fixture(t, async () => { calls++; return new Response('bad error body', { status }); });
  await assert.rejects(adapter.listSessions(), error => error.status === 503);
  assert.equal(calls, 1);
  status = 403;
  await assert.rejects(adapter.readSession('history:native-a'), error => error.status === 403);
  assert.equal(calls, 2);
  status = 404;
  assert.equal((await adapter.readSession('history:native-a')).messages.length, 0);
  assert.equal(calls, 3);
});
