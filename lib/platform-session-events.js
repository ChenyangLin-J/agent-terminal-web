import { randomUUID } from 'node:crypto';

const DEFAULT_PATH = '/api/platform/session-events';
const DEFAULT_HEARTBEAT_MS = 20_000;
const DEFAULT_EVENT_LIMIT = 256;

/**
 * Process-local catalogue event stream. The caller supplies the already-public
 * Session projection; this module narrows it again to list metadata and never
 * reads or attaches a Runtime.
 */
export function createPlatformSessionEvents({
  path = DEFAULT_PATH,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  eventLimit = DEFAULT_EVENT_LIMIT,
  instanceId = randomUUID(),
} = {}) {
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1) throw new TypeError('eventLimit must be a positive integer');
  if (!Number.isFinite(heartbeatMs) || heartbeatMs < 1) throw new TypeError('heartbeatMs must be positive');
  const clients = new Set();
  const events = [];
  let nextEventId = 1;

  function broadcast(value) {
    const summary = catalogueSummary(value);
    if (!summary.id) return null;
    const event = {
      id: nextEventId++,
      data: {
        type: 'session-summary',
        sessionId: summary.id,
        threadId: summary.threadId,
        revision: summary.sessionRevision,
        turnId: summary.turnState?.turnId || '',
        summary,
      },
    };
    events.push(event);
    while (events.length > eventLimit) events.shift();
    for (const response of clients) writeEvent(response, event);
    return event.data;
  }

  function register(app) {
    if (!app?.get) throw new TypeError('An Express app is required');
    app.get(path, (request, response) => {
      response.set({
        'Cache-Control': 'private, no-store',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream',
        'X-Accel-Buffering': 'no',
      });
      response.flushHeaders?.();
      const after = eventCursor(request);
      const oldest = events[0]?.id ?? nextEventId;
      if (after > 0 && after < oldest - 1) {
        writeNamedEvent(response, 'replay-gap', { type: 'replay-gap', snapshotRequired: true, instanceId });
      } else {
        for (const event of events) if (event.id > after) writeEvent(response, event);
      }
      writeNamedEvent(response, 'ready', { type: 'ready', instanceId, lastEventId: nextEventId - 1 });
      clients.add(response);
      const heartbeat = setInterval(() => safeWrite(response, ': keepalive\n\n'), heartbeatMs);
      heartbeat.unref?.();
      request.on('close', () => {
        clearInterval(heartbeat);
        clients.delete(response);
      });
    });
    return () => close();
  }

  function close() {
    for (const response of clients) response.end?.();
    clients.clear();
  }

  return { broadcast, register, close, get clientCount() { return clients.size; } };
}

export function catalogueSummary(value = {}) {
  const sessionId = text(value.sessionId || value.threadId);
  const turnState = value.turnState && typeof value.turnState === 'object' ? {
    active: Boolean(value.turnState.active),
    interrupted: Boolean(value.turnState.interrupted),
    stopping: Boolean(value.turnState.stopping),
    turnId: text(value.turnState.turnId),
    lastCompletedTurnId: text(value.turnState.lastCompletedTurnId),
  } : undefined;
  return compact({
    id: text(value.id),
    sessionId,
    threadId: sessionId,
    title: text(value.title),
    project: text(value.project),
    cwd: text(value.cwd),
    startedAt: timestamp(value.startedAt),
    updatedAt: timestamp(value.lastActivityAt || value.updatedAt || value.startedAt),
    lastActivityAt: timestamp(value.lastActivityAt || value.updatedAt || value.startedAt),
    archived: Boolean(value.archived),
    favorited: Boolean(value.favorited),
    released: Boolean(value.released),
    ready: value.ready !== false,
    pendingServerRequestCount: nonnegativeInteger(value.pendingServerRequestCount),
    resultState: text(value.resultState),
    hasUnreadResult: Boolean(value.hasUnreadResult),
    lastCompletedTurnId: text(value.lastCompletedTurnId),
    lastCompletedAt: timestamp(value.lastCompletedAt),
    lastViewedTurnId: text(value.lastViewedTurnId),
    lastViewedAt: timestamp(value.lastViewedAt),
    sessionRevision: nonnegativeInteger(value.sessionRevision ?? value.uiRevision ?? value.outputRevision),
    turnState,
  });
}

function eventCursor(request) {
  const raw = request?.headers?.['last-event-id'] ?? request?.query?.after ?? 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function writeEvent(response, event) {
  safeWrite(response, `id: ${event.id}\nevent: session-summary\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function writeNamedEvent(response, name, data) {
  safeWrite(response, `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function safeWrite(response, value) {
  try { response.write(value); }
  catch { /* The request close callback removes disconnected clients. */ }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}

function text(value) { return String(value || '').slice(0, 2_000); }
function timestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}
function nonnegativeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
