import assert from 'node:assert/strict';
import test from 'node:test';
import { rememberSessionOperationReceipt, settleSessionOperationReceipt, restoreSessionOperationReceipts, serializableSessionOperationReceipts } from '../lib/session-operation-receipts.js';

test('accepted and failed operation identities survive restoration without storing submitted content', () => {
  const session = { id: 'web-a' };
  const accepted = rememberSessionOperationReceipt(session, 'operation-accepted', { kind: 'submit', fingerprint: 'hash' });
  settleSessionOperationReceipt(session, 'operation-accepted', { result: { kind: 'submit', turnId: 'turn-a', prompt: 'private' } });
  rememberSessionOperationReceipt(session, 'operation-failed', { kind: 'stop' });
  settleSessionOperationReceipt(session, 'operation-failed', { error: new Error('Turn changed') });
  const saved = serializableSessionOperationReceipts(session.operationReceipts);
  const restored = restoreSessionOperationReceipts(saved);
  assert.equal(restored.get('operation-accepted').state, 'accepted');
  assert.equal(restored.get('operation-failed').failure, 'Turn changed');
  assert.equal(JSON.stringify(saved).includes('private'), false);
  assert.equal(rememberSessionOperationReceipt(session, 'operation-accepted'), accepted);
});

test('receipt storage expires old operations and remains bounded', () => {
  const session = { id: 'web-a' };
  for (let i = 0; i < 90; i++) rememberSessionOperationReceipt(session, `operation-${i}`);
  assert.equal(session.operationReceipts.size, 64);
  assert.equal(restoreSessionOperationReceipts(serializableSessionOperationReceipts(session.operationReceipts), Date.now() + 25 * 3600000).size, 0);
});
