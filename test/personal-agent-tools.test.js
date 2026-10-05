import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPersonalConfigStore, defaultPersonalConfig, validatePersonalConfig } from '../lib/personal-agent-config.js';
import { executePersonalTool, personalResult, validateToolContext, dynamicPersonalTools } from '../lib/personal-agent-tools.js';

const context = { sources: [
  { id: 'core', kind: 'document', title: 'Core', text: 'Personal context', path: 'System/Memory/Core.md' },
  { id: 'records:1', kind: 'feeling', title: 'Record', text: 'User feeling', path: 'Life/Records.md', recordedAt: '2026-10-05T12:00:00+08:00' },
  { id: 'session:1', kind: 'conversation', title: 'Session', text: 'User words', href: 'https://agent.chenyanglin.com/?sessionId=one', author: 'user' },
  { id: 'bookmark:1', kind: 'bookmark', title: 'Bookmark', text: 'Captured page excerpt' },
], coverage: [{ source: 'records', status: 'partial' }], window: { from: '2026-10-05' } };
function record() { const config = defaultPersonalConfig(); return { task: config.tasks[0], preferences: config.preferences, toolContext: structuredClone(context), toolReceipts: [], threadId: 'thread', turnId: 'turn' }; }
function invoke(record, id, args = {}) { const receipt = { ...executePersonalTool(record, { tool: id.replaceAll('.', '_'), arguments: args }), threadId: 'thread', turnId: 'turn', callId: String(record.toolReceipts.length) }; record.toolReceipts.push(receipt); return receipt; }

test('config initializes privately, serializes revision CAS and fails closed on corruption', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'personal-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json'), store = createPersonalConfigStore(file);
  const defaults = await store.read(); assert.equal(defaults.revision, 0); assert.equal((await stat(file)).mode & 0o777, 0o600);
  const outcomes = await Promise.allSettled([store.save(defaults), store.save(defaults)]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.status, 409);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1);
  assert.equal(validatePersonalConfig({ ...defaults, extra: true }), false);
  assert.equal(validatePersonalConfig({ ...defaults, tasks: [defaults.tasks[0], defaults.tasks[0]] }), false);
  const denied = structuredClone(defaults); denied.tasks[0].allowedToolIds.push('shell.exec'); assert.equal(validatePersonalConfig(denied), false);
  const invalidPreference = structuredClone(defaults); invalidPreference.tasks[0].allowedToolIds = []; assert.equal(validatePersonalConfig(invalidPreference), false);
  await writeFile(file, 'broken'); await assert.rejects(store.read()); await assert.rejects(store.save(defaults));
});

test('read/search disclose captured coverage and preserve Home kinds, ranges and authors', () => {
  assert.ok(validateToolContext(context));
  const r = record();
  const found = invoke(r, 'home.records.search', { query: 'feeling', from: '2026-10-05' });
  assert.deepEqual(found.readSourceIds, ['records:1']); assert.deepEqual(found.output.coverage, context.coverage); assert.equal(found.output.bounded, true);
  assert.equal(invoke(r, 'personal.context.read').output.items[0].id, 'core');
  const session = invoke(r, 'agent.sessions.read', { sourceId: 'session:1', offset: 0, limit: 4 });
  assert.equal(session.output.items[0].author, 'user'); assert.equal(session.output.items[0].truncated, true);
  assert.equal(invoke(r, 'bookmarks.search').output.items[0].kind, 'bookmark');
  assert.throws(() => invoke(r, 'vault.notes.read', { sourceId: 'core', path: '/etc/passwd' }));
  assert.throws(() => executePersonalTool(r, { tool: 'shell_exec', arguments: {} }));
});

test('only actual reads can produce session/source widgets; Tibetan missing is honest', () => {
  const r = record();
  assert.throws(() => invoke(r, 'home.show_session_action', { sourceId: 'session:1', label: 'Continue' }));
  assert.throws(() => invoke(r, 'home.show_sources', { sourceIds: ['core'] }));
  invoke(r, 'agent.sessions.read', { sourceId: 'session:1' });
  const widget = invoke(r, 'home.show_session_action', { sourceId: 'session:1', label: 'Continue' }).widget;
  assert.deepEqual(widget, { toolId: 'home.show_session_action', type: 'session_action', status: 'available', sourceId: 'session:1', label: 'Continue' });
  invoke(r, 'home.show_sources', { sourceIds: ['session:1'] });
  assert.throws(() => personalResult(r, '{"text":"Hello","reason":"read"}'), /Required/);
  assert.equal(invoke(r, 'home.show_tibetan').widget.status, 'unavailable');
  const result = personalResult(r, '{"text":"Hello","reason":"read"}'); assert.deepEqual(result.sourceIds, ['session:1']); assert.equal(result.widgets.length, 3);
  assert.throws(() => personalResult(r, '{"text":"Hello","reason":"read","widgets":[]}'));
  r.toolContext.sources[2].href = 'https://evil.example/?sessionId=one'; assert.throws(() => invoke(r, 'home.show_session_action', { sourceId: 'session:1', label: 'Continue' }));
});

test('registered Tibetan source and optional preferences use receipt evidence only', () => {
  const r = record(); r.toolContext.sources.push({ id: 'tibetan:1', kind: 'tibetan', title: 'Tibetan', text: '', data: { phrase: 'བོད', meaning: 'Tibet', href: 'https://tibetan.chenyanglin.com/1' } });
  assert.ok(validateToolContext(r.toolContext)); invoke(r, 'home.show_tibetan');
  assert.deepEqual(personalResult(r, '{"text":"Hello","reason":"read"}').sourceIds, ['tibetan:1']);
  const optional = record(); optional.preferences['home.show_tibetan'] = 'optional'; assert.deepEqual(personalResult(optional, '{"text":"Hello","reason":"sparse"}').widgets, []);
  assert.ok(dynamicPersonalTools(optional.task).every(tool => tool.type === 'function' && !tool.name.includes('.') && tool.inputSchema.additionalProperties === false));
  optional.toolReceipts = r.toolReceipts.map(receipt => ({ ...receipt, turnId: 'wrong-turn' })); assert.deepEqual(personalResult(optional, '{"text":"Hello","reason":"sparse"}').sourceIds, []);
});

test('required Session action can honestly report no eligible read conversation', () => {
  const r = record(); r.preferences['home.show_session_action'] = 'required';
  const unavailable = invoke(r, 'home.show_session_action', { label: 'Continue' });
  assert.deepEqual(unavailable.widget, { toolId: 'home.show_session_action', type: 'session_action', status: 'unavailable', label: 'Continue' });
  assert.throws(() => invoke(r, 'home.show_session_action', { sourceId: 'nonexistent', label: 'Continue' }));
  invoke(r, 'home.show_tibetan'); assert.equal(personalResult(r, '{"text":"Hello","reason":"sparse"}').widgets.length, 2);
  invoke(r, 'agent.sessions.read', { sourceId: 'session:1' }); assert.throws(() => invoke(r, 'home.show_session_action', {}), /Choose/);
});

test('Session action optional label has a usable default', () => {
  const r = record();
  invoke(r, 'agent.sessions.read', { sourceId: 'session:1' });
  assert.equal(invoke(r, 'home.show_session_action', { sourceId: 'session:1' }).widget.label, '继续这段讨论');
});
