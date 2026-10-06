const DEFAULT_EVENTS_URL = '/api/platform/session-events';

/** Keep the visible Session catalogue current without opening per-Session transports. */
export function watchAgentWebCatalog({
  controller,
  adapter,
  eventsUrl = DEFAULT_EVENTS_URL,
  createEventSource = (url) => new EventSource(url),
  window: windowObject = globalThis,
  document: documentObject = globalThis.document,
} = {}) {
  if (!controller?.updateSessions || !controller?.getSnapshot) throw new TypeError('A Session Host controller is required');
  if (!adapter?.applyCatalogEvent || !adapter?.reconcileCatalog) throw new TypeError('An Agent Web catalogue adapter is required');
  let source = null;
  let disposed = false;
  let lastEventId = 0;
  let reconcileTask = null;
  let reconcileAbort = null;
  let connectedOnce = false;
  let instanceId = '';

  const visible = () => documentObject?.visibilityState !== 'hidden';
  const reconcile = () => {
    if (disposed || !visible() || reconcileTask) return reconcileTask;
    const displayed = controller.getSnapshot().sessions || [];
    reconcileAbort = new AbortController();
    reconcileTask = Promise.resolve(adapter.reconcileCatalog(displayed, {
      signal: reconcileAbort.signal,
      getCurrent: () => controller.getSnapshot().sessions || [],
    }))
      .then((sessions) => { if (!disposed && sessions) controller.updateSessions(sessions); })
      .catch(() => {})
      .finally(() => { reconcileTask = null; reconcileAbort = null; });
    return reconcileTask;
  };
  const receive = (message) => {
    const parsedId = Number(message?.lastEventId);
    if (Number.isSafeInteger(parsedId) && parsedId > lastEventId) lastEventId = parsedId;
    let event;
    try { event = JSON.parse(String(message?.data || '')); } catch { return; }
    if (event?.type !== 'session-summary') return;
    controller.updateSessions((sessions) => adapter.applyCatalogEvent(sessions, event));
  };
  const ready = (message) => {
    let event;
    try { event = JSON.parse(String(message?.data || '')); } catch { return; }
    const nextInstanceId = String(event?.instanceId || '');
    if (!nextInstanceId) return;
    if (!instanceId) { instanceId = nextInstanceId; return; }
    if (nextInstanceId === instanceId) return;
    instanceId = nextInstanceId;
    const cursor = Number(event?.lastEventId);
    lastEventId = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    // sessionRevision belongs to one server process. Clear the old ordering
    // domain immediately so a new instance's first status event can apply.
    controller.updateSessions((sessions) => sessions.map((session) => ({ ...session, sessionRevision: undefined })));
    const previous = reconcileTask;
    reconcileAbort?.abort();
    if (previous) void previous.finally(() => { if (!disposed && visible()) void reconcile(); });
    else void reconcile();
  };
  const start = () => {
    if (disposed || source || !visible()) return;
    const separator = eventsUrl.includes('?') ? '&' : '?';
    source = createEventSource(`${eventsUrl}${separator}after=${lastEventId}`);
    source.addEventListener?.('session-summary', receive);
    source.addEventListener?.('replay-gap', reconcile);
    source.addEventListener?.('ready', ready);
    source.addEventListener?.('open', () => {
      if (connectedOnce) void reconcile();
      connectedOnce = true;
    });
  };
  const stop = () => {
    reconcileAbort?.abort();
    source?.removeEventListener?.('session-summary', receive);
    source?.removeEventListener?.('replay-gap', reconcile);
    source?.removeEventListener?.('ready', ready);
    source?.close?.();
    source = null;
  };
  const focus = () => { if (visible()) { start(); void reconcile(); } };
  const visibility = () => { if (visible()) focus(); else stop(); };
  windowObject.addEventListener?.('focus', focus);
  documentObject?.addEventListener?.('visibilitychange', visibility);
  start();

  return () => {
    if (disposed) return;
    disposed = true;
    stop();
    windowObject.removeEventListener?.('focus', focus);
    documentObject?.removeEventListener?.('visibilitychange', visibility);
  };
}
