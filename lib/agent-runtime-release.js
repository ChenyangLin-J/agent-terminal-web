/** Orders product attachments sharing one native thread. Runtime semantics stay
 * in the selected client/Platform kernel; this coordinator never closes a shared
 * connection or starts a replacement runtime. */
export class AgentRuntimeReleaseCoordinator {
  constructor({ onError = () => {}, interruptTimeoutMs = 5000 } = {}) {
    this.onError = onError;
    this.interruptTimeoutMs = interruptTimeoutMs;
    this.clients = new WeakMap();
    this.threads = new Map();
  }

  waitForThread(threadId) {
    return this.threads.get(String(threadId || '')) || Promise.resolve();
  }

  release(client, { interrupt = false } = {}) {
    if (!client) return Promise.resolve();
    if (this.clients.has(client)) return this.clients.get(client);
    if (client.closed) return Promise.resolve();
    if (client.ownsConnection) { client.close(); return Promise.resolve(); }
    const threadId = String(client.threadId || '');
    const turnId = String(client.activeTurnId || '');
    const previous = this.threads.get(threadId);
    const operation = Promise.resolve().then(async () => {
      if (previous) await previous.catch(() => {});
      try {
        if (interrupt && threadId && turnId) {
          await client.request('turn/interrupt', { threadId, turnId });
          // Interrupt acknowledgement precedes completion on some providers.
          // Do not unsubscribe while their current Turn is still active.
          const deadline = Date.now() + this.interruptTimeoutMs;
          while (client.activeTurnId === turnId) {
            if (Date.now() >= deadline) throw new Error('Interrupted Turn did not finish before runtime release.');
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        if (threadId) await client.request('thread/unsubscribe', { threadId });
      } catch (error) {
        this.onError({ threadId, turnId, error });
        throw error;
      } finally {
        client.close();
      }
    });
    this.clients.set(client, operation);
    if (threadId) this.threads.set(threadId, operation);
    const cleanup = () => { if (this.threads.get(threadId) === operation) this.threads.delete(threadId); };
    // Release callers may intentionally continue updating the detached product
    // projection. Keep the failure observable to a concurrent resume without an
    // unhandled rejection for a fire-and-forget caller.
    operation.then(cleanup, cleanup);
    return operation;
  }
}
