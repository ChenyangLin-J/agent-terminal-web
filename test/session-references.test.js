import assert from 'node:assert/strict';
import test from 'node:test';
import { requireReferences, resolveAgentWebReferences } from '../lib/session-references.js';
const reference = { hostId: 'agent-web', threadId: 'target', label: 'Untrusted title' };
test('Agent Web reauthorizes identity and keeps recent public reference data', async () => {
  const calls = [];
  const read = async id => { calls.push(id); return { threadId: id, title: 'Authorized title', messages: [{ role: 'user', text: 'question' }, { role: 'assistant', text: 'answer' }] }; };
  const resolved = await resolveAgentWebReferences('source', [reference], read);
  assert.equal(resolved[0].reference.label, 'Authorized title');
  assert.match(resolved[0].context, /assistant: answer/);
  assert.deepEqual(await resolveAgentWebReferences('target', [reference], read), []);
  assert.deepEqual(await resolveAgentWebReferences('source', [{ ...reference, hostId: 'foreign' }], read), []);
  assert.deepEqual(calls, ['target']);
  assert.deepEqual(await resolveAgentWebReferences('source', [reference], async () => null), []);
  assert.deepEqual(await resolveAgentWebReferences('source', [reference], async () => ({ threadId: 'target', archived: true })), []);
  assert.throws(() => requireReferences([reference, reference]));
  assert.throws(() => requireReferences('invalid'));
});
