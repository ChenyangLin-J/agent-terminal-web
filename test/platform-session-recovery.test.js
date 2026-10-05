import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionHostController } from '@agent-workbench/platform/session-host';
import { createAgentWebSessionAdapter } from '../public/platform-agent-web-adapter.js';

for (const kind of ['released', 'historical']) {
  test(`${kind} preview promotes once to a live subscription and rejects a late preview read`, async t => {
    const originals = Object.fromEntries(['fetch', 'sessionStorage', 'location', 'WebSocket', 'setInterval', 'clearInterval'].map(key => [key, globalThis[key]]));
    const stored = new Map(), calls = [], polls = new Map(), sockets = [];
    const id = kind === 'released' ? 'old-web' : 'history:thread-a';
    const old = { id: 'old-web', sessionId: 'thread-a', released: true, cwd: '/project', title: 'Existing' };
    const live = { id: 'live-web', sessionId: 'thread-a', ready: true, released: false, cwd: '/project', title: 'Existing', turnState: { active: false, turnId: 'turn-new' } };
    let previewReads = 0, finishPreview;
    const preview = { cwd: '/project', conversation: { turns: [{ id: 'turn-old', user: 'old message', assistant: [{ text: 'old answer' }] }] } };
    globalThis.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
    globalThis.location = { protocol: 'http:', host: 'localhost' };
    globalThis.setInterval = callback => { const token = Symbol(); polls.set(token, callback); return token; };
    globalThis.clearInterval = token => polls.delete(token);
    const response = value => ({ ok: true, json: async () => value });
    globalThis.fetch = async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', payload: options.body && JSON.parse(options.body) });
      if (url.startsWith('/api/platform/sessions?')) return response({ sessions: [old] });
      if (url === '/api/platform/sessions/old-web') return response({ session: old });
      if (url.startsWith('/api/session-preview/')) {
        if (++previewReads === 2) return new Promise(resolve => { finishPreview = () => resolve(response(preview)); });
        return response(preview);
      }
      if (url.startsWith('/api/platform/session-metadata')) return response({ currentModel: 'gpt-6.1-sol', currentReasoningEffort: 'xhigh' });
      if (url === '/api/platform/sessions' && options.method === 'POST') return response({ session: live });
      if (url === '/api/platform/sessions/live-web') return response({ session: live, items: [
        { id: 'native-old-user', type: 'user', text: 'old message', turnId: 'turn-old' },
        { id: 'native-old-answer', type: 'assistant', phase: 'final_answer', text: 'old answer', turnId: 'turn-old' },
        { id: 'new-message', type: 'user', text: 'first send', turnId: 'turn-new' },
      ] });
      if (url.endsWith('/actions/executionProfile')) return response({ accepted: true });
      throw new Error(`Unexpected fetch ${url}`);
    };
    globalThis.WebSocket = class {
      listeners = new Map(); readyState = 1; closed = false;
      constructor() { sockets.push(this); queueMicrotask(() => this.listeners.get('open')?.({})); }
      addEventListener(type, listener) { this.listeners.set(type, listener); }
      send(raw) {
        const message = JSON.parse(raw); calls.push({ url: 'ws:submit', payload: message });
        live.turnState.active = true;
        this.listeners.get('message')?.({ data: JSON.stringify({ type: 'status', payload: live }) });
        this.listeners.get('message')?.({ data: JSON.stringify({ type: 'control-ack', payload: { idempotencyKey: message.idempotencyKey } }) });
      }
      close() { this.closed = true; }
    };
    const adapter = createAgentWebSessionAdapter({ clientId: 'test' });
    const controller = createSessionHostController({ adapter, initialSessionId: id });
    t.after(() => { controller.dispose(); adapter.dispose(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
    await controller.start();
    assert.equal(controller.getSnapshot().session.preview, true);
    const slowPoll = [...polls.values()][0]();
    await controller.execute('send', { text: 'first send' });
    let snapshot = controller.getSnapshot().session;
    assert.equal(snapshot.sessionId, id);
    assert.equal(snapshot.threadId, 'thread-a');
    assert.equal(snapshot.status, 'running');
    assert.equal(snapshot.released, false);
    assert.equal(snapshot.preview, false);
    assert.equal(snapshot.webSessionId, 'live-web');
    assert.equal(snapshot.messages.filter(message => message.content === 'old message').length, 1);
    assert.equal(polls.size, 0);
    assert.equal(calls.find(call => call.method === 'POST' && call.url === '/api/platform/sessions').payload.cwd, '/project');
    finishPreview(); await slowPoll;
    assert.equal(controller.getSnapshot().session.status, 'running');
    assert.equal(controller.getSnapshot().session.webSessionId, 'live-web');
    await controller.execute('send', { text: 'second send' });
    assert.equal(calls.filter(call => call.method === 'POST' && call.url === '/api/platform/sessions').length, 1);
    assert.equal(calls.filter(call => call.url.endsWith('/actions/executionProfile')).length, 1);
    assert.equal(sockets.length, 1); assert.equal(sockets[0].closed, false);
    assert.equal(calls.filter(call => call.url === 'ws:submit').length, 2);
    assert.equal((await adapter.loadHistory(id)).status, 'running');
    // A reload retains aliases even when the sidebar still contains an older released row.
    const reloaded = createAgentWebSessionAdapter({ clientId: 'reload' });
    await reloaded.listSessions();
    snapshot = await reloaded.readSession(id);
    assert.equal(snapshot.status, 'running'); assert.equal(snapshot.webSessionId, 'live-web');
    reloaded.dispose();
  });
}
