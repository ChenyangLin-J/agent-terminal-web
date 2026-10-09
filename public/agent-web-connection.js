/** Agent Web's WebSocket transport. Session state/recovery is owned by Platform Host Kit. */
export function createAgentWebConnection(id, { clientId, afterRevision, WebSocketClass = globalThis.WebSocket, origin = globalThis.location, schedule = setTimeout, cancel = clearTimeout, connectTimeoutMs = 12000 } = {}) {
  const listeners = new Set();
  const stateListeners = new Set();
  const pending = new Map();
  let socket;
  let disposed = false;
  let retryTimer;
  let connectTimer;
  let retryDelay = 500;
  let resolveReady;
  let rejectReady;
  let ready;
  let state = { status: 'connecting' };
  function announce(value) { state = value; for (const listener of stateListeners) listener(value); }
  function open() {
    ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Reconnection can occur without an operation awaiting ready.
    ready.catch(() => {});
    const query = new URLSearchParams({ attach: id, clientId, replay: '1' });
    if (Number.isFinite(afterRevision)) query.set('afterRevision', String(afterRevision));
    socket = new WebSocketClass(`${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}/terminal?${query}`);
    const current = socket;
    connectTimer = schedule(() => {
      if (disposed || current !== socket || current.readyState === 1) return;
      rejectReady(new Error('连接 Agent Web 超时，请稍后重试。'));
      current.close();
    }, connectTimeoutMs);
    current.addEventListener('open', () => {
      if (disposed || current !== socket) return;
      cancel(connectTimer); retryDelay = 500; announce({ status: 'connected' }); resolveReady(connection);
    });
    current.addEventListener('message', (raw) => {
      if (disposed || current !== socket) return;
      let event; try { event = JSON.parse(raw.data); } catch { return; }
      const payload = event.payload || {};
      const receipt = payload.idempotencyKey ? pending.get(payload.idempotencyKey) : null;
      const failed = ['error', 'side-chat-error', 'realtime-error'].includes(event.type);
      if (receipt && (failed || receipt.responseTypes.includes(event.type))) {
        cancel(receipt.timeout); pending.delete(payload.idempotencyKey);
        if (!failed) receipt.resolve(payload);
        else { const error = new Error(payload.message || 'Session action failed.'); error.knownResult = payload.receiptState === 'failed'; receipt.reject(error); }
      }
      for (const listener of listeners) listener({ ...event, sessionId: id, ...(payload.sessionRevision == null ? {} : { revision: payload.sessionRevision }) });
    });
    current.addEventListener('error', () => { if (!disposed && current === socket) rejectReady(new Error('Unable to connect to Agent Web.')); });
    current.addEventListener('close', () => {
      if (disposed || current !== socket) return;
      cancel(connectTimer); announce({ status: 'reconnecting' }); rejectReady(new Error('Agent Web connection closed.'));
      for (const operation of pending.values()) { cancel(operation.timeout); operation.reject(new Error('Connection lost; the operation result is unknown. Retry retains its ID.')); }
      pending.clear();
      retryTimer = schedule(open, retryDelay); retryDelay = Math.min(5000, retryDelay * 2);
    });
  }
  const connection = {
    listeners,
    stateListeners,
    get state() { return state; },
    get ready() { return ready; },
    async sendUnacknowledged(message) { await ready; if (disposed || socket.readyState !== 1) throw new Error('Session connection is recovering.'); socket.send(JSON.stringify(message)); },
    async send(message, { idempotencyKey, responseTypes = ['control-ack'], signal } = {}) {
      await ready;
      if (signal?.aborted) throw new DOMException('Submission cancelled before sending.', 'AbortError');
      if (disposed || socket.readyState !== 1) throw new Error('Session connection is recovering.');
      const key = idempotencyKey || message.idempotencyKey || globalThis.crypto.randomUUID();
      if (pending.has(key)) throw new Error('An operation with this ID is already pending.');
      return new Promise((resolve, reject) => {
        const timeout = schedule(() => { pending.delete(key); reject(new Error('Operation receipt timed out; retry retains its ID.')); }, 20000);
        pending.set(key, { resolve, reject, timeout, responseTypes });
        // Register before sending: a loopback/test transport may reply synchronously.
        try { socket.send(JSON.stringify({ ...message, idempotencyKey: key })); }
        catch (error) {
          cancel(timeout); pending.delete(key); reject(error);
        }
      });
    },
    dispose() {
      disposed = true; cancel(retryTimer); cancel(connectTimer); rejectReady(new Error('Session connection released.')); socket?.close();
      for (const operation of pending.values()) { cancel(operation.timeout); operation.reject(new Error('Session connection released.')); }
      pending.clear(); listeners.clear(); stateListeners.clear();
    },
  };
  open();
  return connection;
}
