import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyAgentWebEvent, createAgentWebSessionAdapter, normalizeSnapshot, previewSnapshot } from "../public/platform-agent-web-adapter.js";
import { agentWebSessionContext } from '../public/platform-agent-web-adapter.js';

test('lazy metadata keeps drafts local, loads only on demand, and deduplicates retriable reads', async t => {
  const originals = { fetch: globalThis.fetch, localStorage: globalThis.localStorage };
  const stored = new Map();
  globalThis.localStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const calls = []; let unavailable = true;
  globalThis.fetch = async url => {
    calls.push(url);
    assert.match(url, /^\/api\/platform\/session-metadata\?/);
    if (unavailable) return Response.json({ error: 'models offline' }, { status: 503 });
    return Response.json({ currentModel: 'saved-default', currentReasoningEffort: 'high', models: [{ id: 'saved-default' }] });
  };
  const adapter = createAgentWebSessionAdapter({ clientId: 'lazy-test', lazyMetadata: true });
  t.after(() => { adapter.dispose(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const draft = await adapter.createSession({ cwd: '/lazy-project' }, { idempotencyKey: 'lazy-draft' });
  await adapter.readSession(draft.id);
  await adapter.execute(draft.id, 'readContext');
  assert.equal(calls.length, 0);
  await assert.rejects(adapter.loadExecutionOptions(draft.id), /models offline/);
  assert.equal((await adapter.readSession(draft.id)).isDraft, true);
  unavailable = false;
  const [first, second] = await Promise.all([adapter.loadExecutionOptions(draft.id), adapter.loadExecutionOptions(draft.id)]);
  assert.equal(first.executionProfile.model, 'saved-default');
  assert.equal(second.executionProfile.reasoningEffort, 'high');
  assert.equal(calls.length, 2);
  await adapter.loadExecutionOptions(draft.id);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1], 'http://test.invalid').searchParams.get('cwd'), '/lazy-project');
});

test('Composer receives product context usage from the selected Host snapshot, independently of UI presentation fields', async () => {
  const usage = { contextUsedTokens: 6000, modelContextWindow: 258400 };
  let snapshot = normalizeSnapshot({ session: { id: 'web-a', sessionId: 'thread-a', tokenUsage: usage } });
  const calls = [];
  const controller = { getSnapshot: () => ({ session: snapshot }), execute: (...args) => calls.push(args) };
  const view = { sessionId: 'web-a', isDraft: false };
  assert.equal(agentWebSessionContext(controller, view).usage, usage);
  await agentWebSessionContext(controller, view).onRead();
  assert.deepEqual(calls[0], ['readContext', {}, { sessionId: 'web-a' }]);
  snapshot = { ...snapshot, tokenUsage: { contextUsedTokens: 12000, modelContextWindow: 258400 } };
  assert.equal(agentWebSessionContext(controller, view).usage.contextUsedTokens, 12000);
  assert.equal(agentWebSessionContext(controller, { sessionId: 'web-b' }).usage, null);
  assert.equal(agentWebSessionContext(controller, { sessionId: 'web-a', isDraft: true }).onCompact, undefined);
});
test('historical preview exposes each turn for lazy process loading without a live Runtime',()=>{
 const turnId='019f8d05-7a2d-7f43-a52c-caa9f5dcd1cf';
 const snapshot=previewSnapshot('history:thread-1',{conversation:{turns:[{id:turnId,user:'question',assistant:[{text:'answer'}]}]}});
 assert.deepEqual(snapshot.technicalDetailsAvailable,[turnId]);
 assert.deepEqual(snapshot.technicalItems,[]);
 assert.equal(snapshot.threadId,'thread-1');
});

test('historical display IDs without a native turn do not advertise an invalid process request', () => {
 const snapshot=previewSnapshot('history:thread-1',{conversation:{turns:[{id:'disk-response-user-1',user:'question',assistant:[{text:'progress',phase:'commentary'},{text:'answer'}]}]}});
 assert.deepEqual(snapshot.technicalDetailsAvailable,[]);
 assert.equal(snapshot.technicalItems[0].title,'进度说明');
 assert.equal(snapshot.messages.length,2);
});

test('opening, refreshing and paging historical sessions retain their catalog titles', async t => {
  const originalFetch = globalThis.fetch;
  const adapter = createAgentWebSessionAdapter({ clientId: 'history-title-test' });
  const calls = [];
  const titles = ['Task: 晚间', '我们继续讨论 personal agent'];
  globalThis.fetch = async raw => {
    const url = new URL(raw, 'http://test.invalid');
    calls.push(url.pathname + url.search);
    if (url.pathname === '/api/platform/sessions') return Response.json({ sessions: titles.map((title, index) => ({ id: `history:thread-${index}`, sessionId: `thread-${index}`, title })) });
    if (url.pathname.startsWith('/api/session-preview/')) return Response.json({ conversation: { turns: [{ id: url.searchParams.has('before') ? 'older' : 'latest', user: 'question', assistant: [{ text: 'answer' }] }], nextCursor: url.searchParams.has('before') ? null : '10', hasEarlier: !url.searchParams.has('before') } });
    if (url.pathname === '/api/platform/session-metadata') return Response.json({});
    throw new Error(`Unexpected fetch ${raw}`);
  };
  t.after(() => { adapter.dispose(); globalThis.fetch = originalFetch; });
  let summaries = (await adapter.listSessions()).sessions;
  for (const [index, title] of titles.entries()) {
    const id = `history:thread-${index}`;
    for (const snapshot of [await adapter.readSession(id), await adapter.readSession(id), await adapter.loadHistory(id)]) {
      assert.equal(snapshot.title, title);
      assert.equal(snapshot.titleIsFallback, false);
      summaries = adapter.patchSummary(summaries, snapshot);
      assert.equal(summaries.find(summary => summary.id === id).title, title);
    }
  }
  assert.equal(calls.some(url => url.includes('before=10')), true);
  assert.equal(calls.some(url => /\/api\/platform\/sessions\/[^?]/.test(url)), false);
});

test('a preview opened before its catalog cannot replace the title with its placeholder', async t => {
  const originalFetch = globalThis.fetch;
  const adapter = createAgentWebSessionAdapter({ clientId: 'history-title-race-test' });
  const id = 'history:thread-race';
  globalThis.fetch = async raw => {
    const url = new URL(raw, 'http://test.invalid');
    if (url.pathname === '/api/platform/sessions') return Response.json({ sessions: [{ id, sessionId: 'thread-race', title: 'Task: 晚间' }] });
    if (url.pathname.startsWith('/api/session-preview/')) return Response.json({ conversation: { turns: [], nextCursor: url.searchParams.has('before') ? null : '10' } });
    if (url.pathname === '/api/platform/session-metadata') return Response.json({}, { status: 404 });
    throw new Error(`Unexpected fetch ${raw}`);
  };
  t.after(() => { adapter.dispose(); globalThis.fetch = originalFetch; });
  const summary = { id, title: 'Task: 晚间' };
  const first = await adapter.readSession(id);
  assert.equal(first.title, '历史对话');
  assert.equal(first.titleIsFallback, true);
  assert.equal(adapter.patchSummary([summary], first)[0].title, summary.title);
  const earlier = await adapter.loadHistory(id);
  assert.equal(earlier.titleIsFallback, true);
  assert.equal(adapter.patchSummary([summary], earlier)[0].title, summary.title);
  await adapter.listSessions();
  const loaded = await adapter.readSession(id);
  assert.equal(loaded.title, summary.title);
  assert.equal(loaded.titleIsFallback, false);
});

test('a genuine historical title may be exactly the placeholder text', () => {
  const adapter = createAgentWebSessionAdapter({ clientId: 'history-real-title-test' });
  try {
    for (const snapshot of [
      previewSnapshot('history:thread-real', { conversation: { turns: [] } }, { title: '历史对话' }),
      previewSnapshot('history:thread-real', { preview: { title: '历史对话' }, conversation: { turns: [] } }),
    ]) {
      assert.equal(snapshot.titleIsFallback, false);
      assert.equal(adapter.patchSummary([{ id: snapshot.sessionId, title: 'Old title' }], snapshot)[0].title, '历史对话');
    }
  } finally { adapter.dispose(); }
});

test("Platform adapter retains Agent Web session and Codex thread identities", () => {
  const snapshot = normalizeSnapshot({
    session: { id: "web-a", sessionId: "thread-a", title: "Existing", outputRevision: 8, turnState: { turnId: "turn-a" } },
    transcript: { items: [{ id: "item-a" }] },
  });
  assert.equal(snapshot.sessionId, "web-a");
  assert.equal(snapshot.threadId, "thread-a");
  assert.equal(snapshot.activeTurnId, "turn-a");
  assert.equal(snapshot.revision, 8);
});

test("Platform adapter ignores a lower replay revision and targets request state", () => {
  const snapshot = { revision: 12, pendingRequests: [{ requestId: "old" }], items: [] };
  const replayed = applyAgentWebEvent(snapshot, { type: "replay", payload: { revision: 7 } });
  assert.equal(replayed.revision, 12);
  const requested = applyAgentWebEvent(replayed, { type: "agent-request", payload: { requestId: "request-a", turnId: "turn-a" } });
  assert.deepEqual(requested.pendingRequests.map((request) => request.requestId), ["old", "request-a"]);
  const resolved = applyAgentWebEvent(requested, { type: "agent-request-resolved", payload: { requestId: "request-a" } });
  assert.deepEqual(resolved.pendingRequests.map((request) => request.requestId), ["old"]);
});

test('updating a process item retains its original chronological position', () => {
  const snapshot = normalizeSnapshot({ session: { id: 'web-a' }, items: [{ id: 'command-a', type: 'command', text: 'run', turnId: 'turn-a' }, { id: 'comment-b', type: 'assistant', text: 'next', phase: 'commentary', turnId: 'turn-a' }] });
  const updated = applyAgentWebEvent(snapshot, { type: 'app-transcript-upsert', payload: { id: 'command-a', type: 'command', text: 'run', output: 'done', turnId: 'turn-a' } });
  assert.deepEqual(updated.items.map(item => item.id), ['command-a', 'comment-b']);
});

test("server persists bounded idempotency receipts and exposes the Platform snapshot", async () => {
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const routes = await readFile(new URL('../lib/platform-session-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /app\.get\('\/api\/platform\/sessions\/:id'/);
  assert.match(routes, /app\.post\('\/api\/platform\/sessions'/);
  assert.match(server, /operationReceipts: serializableSessionOperationReceipts/);
  assert.match(server, /isIdempotentSessionMessage\(message\)/);
  assert.match(server, /replayed: true/);
});

test("candidate build never silently bundles the stable package without Session Host", async () => {
  const script = await readFile(new URL("../scripts/build-session-app.mjs", import.meta.url), "utf8");
  assert.match(script, /AGENT_PLATFORM_CANDIDATE/);
  assert.match(script, /src", "session-host\.js/);
  assert.match(script, /entryNames: "session-app-\[hash\]"/);
});

test("entry uses the public UI callback shapes and ships its shared styles", async () => {
  const entry = await readFile(new URL("../public/platform-agent-web-entry.jsx", import.meta.url), "utf8");
  assert.match(entry, /\{ prompt, mode, attachments, references \}/);
  assert.match(entry, /\{ token, decision, answers \}/);
  assert.match(entry, /\{ prompt, turnId, messageId, attachments, references \}/);
  assert.match(entry, /@agent-workbench\/platform\/styles\.css/);
  assert.match(entry, /katex\/dist\/katex\.min\.css/);
  assert.match(entry, /onUploadAttachments: uploadAgentWebAttachments/);
});

test('draft paints before metadata, stays local for settings/archive, and applies the full profile before first send with retry', async t => {
  const { createAgentWebSessionAdapter } = await import('../public/platform-agent-web-adapter.js');
  const originals = Object.fromEntries(['fetch', 'sessionStorage', 'location', 'WebSocket'].map(key => [key, globalThis[key]]));
  const stored = new Map();
  globalThis.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  globalThis.location = { protocol: 'http:', host: 'localhost' };
  const calls = []; let resolveMetadata, rejectProfile = true;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, payload: options.body ? JSON.parse(options.body) : null });
    if (url.startsWith('/api/platform/session-metadata')) return new Promise(resolve => { resolveMetadata = value => resolve({ ok: true, json: async () => value }); });
    if (url === '/api/platform/sessions' && options.method === 'POST') return { ok: true, json: async () => ({ session: { id: 'web-first', sessionId: 'thread-first', ready: true } }) };
    if (url.includes('/actions/executionProfile')) {
      if (rejectProfile) { rejectProfile = false; return { ok: false, status: 409, json: async () => ({ error: 'temporary configuration failure' }) }; }
      return { ok: true, json: async () => ({ accepted: true }) };
    }
    if (url.startsWith('/api/platform/sessions?')) return { ok: true, json: async () => ({ sessions: [] }) };
    throw new Error(`Unexpected fetch ${url}`);
  };
  globalThis.WebSocket = class {
    listeners = new Map(); readyState = 1;
    constructor() { queueMicrotask(() => this.listeners.get('open')?.({})); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    send(value) { const payload = JSON.parse(value); calls.push({ url: 'websocket:submit', payload }); this.listeners.get('message')?.({ data: JSON.stringify({ type: 'control-ack', payload: { idempotencyKey: payload.idempotencyKey } }) }); }
    close() {}
  };
  const adapter = createAgentWebSessionAdapter({ clientId: 'test' });
  t.after(() => { adapter.dispose(); for (const [key, value] of Object.entries(originals)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const draft = await adapter.createSession({ cwd: '/project' }, { idempotencyKey: 'draft-create-test' });
  const initial = await adapter.readSession(draft.id);
  assert.equal(initial.isDraft, true); assert.equal(initial.tokenUsage, null);
  assert.equal(calls.some(call => call.url === '/api/platform/sessions'), false);
  const events = []; adapter.subscribeSession(draft.id, { onEvent: event => events.push(event) });
  resolveMetadata({ currentModel: 'gpt-6.1-sol', currentReasoningEffort: 'xhigh', models: [{ id: 'gpt-6.1-sol', name: '6.1', reasoningEfforts: ['xhigh'] }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(events.at(-1).payload.executionProfile.model, 'gpt-6.1-sol');
  assert.equal((await adapter.readSession(draft.id)).executionProfile.reasoningEffort, 'xhigh');
  await adapter.execute(draft.id, 'executionProfile', { model: 'codex', reasoningEffort: 'medium', accessMode: 'restricted', serviceTier: 'priority' });
  await adapter.execute(draft.id, 'favorite', { favorited: true });
  await adapter.execute(draft.id, 'archive', { archived: true });
  assert.equal((await adapter.listSessions()).sessions.length, 0);
  assert.equal((await adapter.listSessions({ archived: true })).sessions[0].favorited, true);
  await adapter.execute(draft.id, 'archive', { archived: false });
  await assert.rejects(adapter.execute(draft.id, 'send', { text: 'first' }, { idempotencyKey: 'send-a' }), /temporary/);
  await adapter.execute(draft.id, 'send', { text: 'first' }, { idempotencyKey: 'send-a' });
  assert.equal(calls.filter(call => call.url === '/api/platform/sessions').length, 1);
  const create = calls.find(call => call.url === '/api/platform/sessions'); assert.equal(create.payload.access, 'safe');
  const profile = calls.filter(call => call.url.includes('/actions/executionProfile')).at(-1);
  assert.deepEqual([profile.payload.model, profile.payload.reasoningEffort, profile.payload.accessMode, profile.payload.serviceTier], ['codex', 'medium', 'restricted', 'priority']);
  assert.equal(calls.at(-1).url, 'websocket:submit');
});

test('historical preview projects actual usage and configuration without launching runtime', () => {
  const snapshot = previewSnapshot('history:thread-a', { cwd: '/history', model: 'configured', reasoningEffort: 'high', access: 'safe', tokenUsage: { contextUsedTokens: 123, modelContextWindow: 456 }, conversation: { turns: [] } });
  assert.deepEqual(snapshot.tokenUsage, { contextUsedTokens: 123, modelContextWindow: 456 });
  assert.equal(snapshot.executionProfile.model, 'configured'); assert.equal(snapshot.executionProfile.accessMode, 'restricted');
});
