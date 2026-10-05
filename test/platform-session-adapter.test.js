import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { applyAgentWebEvent, normalizeSnapshot, previewSnapshot } from "../public/platform-agent-web-adapter.js";
import { agentWebSessionContext } from '../public/platform-agent-web-adapter.js';

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
 const snapshot=previewSnapshot('history:thread-1',{conversation:{turns:[{id:'turn-1',user:'question',assistant:[{text:'answer'}]}]}});
 assert.deepEqual(snapshot.technicalDetailsAvailable,['turn-1']);
 assert.deepEqual(snapshot.technicalItems,[]);
 assert.equal(snapshot.threadId,'thread-1');
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
  assert.match(script, /entryNames: "session-app"/);
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
