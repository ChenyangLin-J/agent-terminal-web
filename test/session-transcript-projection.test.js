import test from 'node:test';
import assert from 'node:assert/strict';
import { projectSessionTranscript } from '../lib/session-transcript-projection.js';
import { normalizeSnapshot, applyAgentWebEvent } from '../public/platform-agent-web-adapter.js';
const done = '11111111-1111-4111-8111-111111111111';
const active = '22222222-2222-4222-8222-222222222222';
test('large completed execution does not delay public conversation; full process data remains intact', () => {
  const citations = { entries: [{ path: 'memory.md', lineStart: 1 }] };
  const items = [{ id: 'question', type: 'user', text: 'hello', turnId: done, attachments: [{ path: 'note.md' }] },
    ...Array.from({ length: 315 }, (_, i) => ({ id: `tool-${i}`, type: 'command', turnId: done, output: 'output'.repeat(10000) })),
    { id: 'answer', type: 'assistant', phase: 'final_answer', text: 'done', turnId: done, memoryCitation: citations },
    { id: 'current', type: 'assistant', phase: 'commentary', text: 'working', turnId: active }];
  const before = JSON.stringify(items).length;
  const transcript = projectSessionTranscript(items, { activeTurnId: active });
  assert.ok(before > 18_000_000);
  assert.ok(JSON.stringify(transcript).length < 2000);
  assert.deepEqual(transcript.items.map(i => i.id), ['question', 'answer', 'current']);
  assert.deepEqual(transcript.technicalDetailsAvailable, [done]);
  assert.equal(items[1].output.length, 60000);
  const snapshot = normalizeSnapshot({ session: { id: 'web', sessionId: 'native', turnState: { active: true, turnId: active } }, transcript });
  assert.deepEqual(snapshot.technicalDetailsAvailable, [done]);
  assert.deepEqual(snapshot.messages[1].memoryCitation, citations);
  assert.equal(snapshot.technicalItems[0].text, 'working');
  assert.deepEqual(applyAgentWebEvent(snapshot, { type: 'status', payload: snapshot.session }).technicalDetailsAvailable, [done]);
});
test('completed live details become lazy without treating final text as completion', () => {
  const items = [{ id: 'progress', turnId: active, type: 'command', output: 'in progress' },
    { id: 'final', turnId: active, type: 'assistant', phase: 'final_answer', text: 'answer' }];
  assert.equal(projectSessionTranscript(items, { activeTurnId: active }).items.length, 2);
  const complete = projectSessionTranscript(items);
  assert.deepEqual(complete.items.map(item => item.id), ['final']);
  assert.deepEqual(complete.technicalDetailsAvailable, [active]);
  const snapshot = normalizeSnapshot({ session: { id: 'web', turnState: { active: false, turnId: active } }, transcript: complete });
  assert.equal(snapshot.activeTurnId, '');
});
test('legacy details stay visible when there is no addressable native process endpoint', () => {
  const items = [{ id: 'legacy', turnId: 'old-turn', type: 'command', output: 'legacy output' }];
  assert.deepEqual(projectSessionTranscript(items), { items, technicalDetailsAvailable: [] });
});
