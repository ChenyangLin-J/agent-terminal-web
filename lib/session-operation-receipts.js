export const SESSION_OPERATION_RECEIPT_LIMIT = 64;
export const SESSION_OPERATION_RECEIPT_TTL_MS = 24 * 60 * 60 * 1_000;

export function restoreSessionOperationReceipts(value, now = Date.now()) {
  const receipts = new Map();
  for (const receipt of Array.isArray(value) ? value : []) {
    const key = String(receipt?.key || '');
    const receivedAt = Number(receipt?.receivedAt || 0);
    if (!isValidOperationReceiptKey(key) || !receivedAt || now - receivedAt > SESSION_OPERATION_RECEIPT_TTL_MS) continue;
    receipts.set(key, { ...receipt, key, receivedAt });
  }
  return receipts;
}

export function serializableSessionOperationReceipts(receipts, now = Date.now()) {
  return [...(receipts instanceof Map ? receipts.values() : [])]
    .filter((receipt) => now - Number(receipt?.receivedAt || 0) <= SESSION_OPERATION_RECEIPT_TTL_MS)
    .slice(-SESSION_OPERATION_RECEIPT_LIMIT)
    .map(({ key, kind, sessionId, receivedAt, fingerprint, state, failure, result }) => ({ key, kind, sessionId, receivedAt, fingerprint, state, failure, result }));
}

export function isValidOperationReceiptKey(value) {
  return /^[a-z0-9][a-z0-9_:-]{7,199}$/i.test(value);
}

export function isIdempotentSessionMessage(message) {
  return ['submit', 'command', 'edit-and-fork', 'agent-response', 'resume-interrupted', 'interrupt-turn', 'side-chat-submit', 'side-chat-stop', 'realtime-start', 'realtime-stop'].includes(String(message?.type || ''));
}

export function rememberSessionOperationReceipt(session, key, receipt = {}, onChange = () => {}) {
  if (!session || !isValidOperationReceiptKey(String(key || ''))) return null;
  session.operationReceipts ||= new Map();
  const existing = session.operationReceipts.get(key);
  if (existing) return existing;
  const next = {
    key,
    kind: String(receipt.kind || 'action'),
    sessionId: String(receipt.sessionId || session.id),
    receivedAt: Date.now(),
    fingerprint: String(receipt.fingerprint || ''),
    state: receipt.state || 'pending',
    failure: '',
  };
  session.operationReceipts.set(key, next);
  while (session.operationReceipts.size > SESSION_OPERATION_RECEIPT_LIMIT) session.operationReceipts.delete(session.operationReceipts.keys().next().value);
  onChange();
  return next;
}

export function settleSessionOperationReceipt(session, key, { result = null, error = null } = {}, onChange = () => {}) {
  const receipt = session?.operationReceipts?.get(key);
  if (!receipt) return null;
  receipt.state = error ? 'failed' : 'accepted';
  receipt.failure = error ? String(error.message || error).slice(0, 1000) : '';
  // Store only the public action result, never a prompt, attachment content or credential.
  const keys = ['kind', 'deliveryMode', 'turnId', 'threadId', 'sessionId', 'title', 'branchCreated', 'queued', 'queuedTurnId'];
  receipt.result = result ? Object.fromEntries(keys.filter((field) => result[field] !== undefined).map((field) => [field, result[field]])) : null;
  onChange();
  return receipt;
}
