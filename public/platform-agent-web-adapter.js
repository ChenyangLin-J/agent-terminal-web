import { parseSessionReferenceEnvelopes } from '@agent-workbench/platform/session-references';
import { createAgentWebConnection } from './agent-web-connection.js';
const WS_OPEN = 1;
const RETRYABLE_ACTIONS = new Set([
  "send", "append", "queue", "respond", "approve", "decline", "stop", "resume", "editFork", "fork",
]);

export function createAgentWebSessionAdapter({ clientId = browserClientId(), sourceSession = '', title = '', notificationTarget = {} } = {}) {
  const listeners = new Set();
  const connections = new Map();
  const targets = storedEntries('agent-web.session-aliases');
  const catalogs = new Map();
  const metadataReads = new Map();
  const launches = new Map();
  const pendingProfiles = storedEntries('agent-web.pending-profiles');
  const profileApplications = new Map();
  const historyProfiles = new Map();
  const drafts = storedEntries('agent-web.session-drafts');
  const draftSubscriptions = new Map();
  const historySubscriptions = new Map();
  const summaries = new Map();
  const released = new Map();
  const previews = new Map();
  const processes = new Map();
  const withProcesses = (snapshot) => {
    const loaded = [...processes].filter(([key]) => key.startsWith(`${snapshot.threadId}:`)).flatMap(([, items]) => items);
    if (!loaded.length) return snapshot;
    const items = [...new Map([...(snapshot.items || []), ...loaded].map(item => [item.id, item])).values()];
    const presentation = presentationFromAgentWeb(snapshot.session || {}, items, snapshot.pendingRequests);
    return { ...snapshot, items, messages: presentation.messages, technicalItems: presentation.technicalItems, turnMetadata: presentation.turnMetadata };
  };

  const emit = (event) => listeners.forEach((listener) => listener(event));

  const adapter = {
    resolveSessionId: (id) => [...targets].find(([, target]) => target === id)?.[0] || id,
    async listSessions({ query = "", archived = false, cursor = null, signal } = {}) {
      const params = new URLSearchParams({ q: query, archived: archived ? '1' : '0' });
      if (cursor) params.set('cursor', cursor);
      const result = await json(`/api/platform/sessions?${params}`, { signal });
      const aliases = new Map([...targets].map(([alias, target]) => [target, alias]));
      const values = (result.sessions || []).map((value) => normalizeSession({ ...value, id: aliases.get(value.id) || value.id }));
      for (const value of values) summaries.set(value.id, value);
      for (const draft of drafts.values()) if (!targets.has(draft.id) && (archived || !draft.archived) && (!query || draft.title.toLowerCase().includes(query.toLowerCase()))) values.unshift(draft);
      return { ...result, sessions: values };
    },

    async searchSessionReferences(id, query) {
      const result = await adapter.listSessions({ query });
      const source = previews.get(id)?.threadId || summaries.get(id)?.threadId;
      return { references: result.sessions.map(item => item.reference).filter(item => item && item.threadId !== source && !item.archived) };
    },
    resolveSessionReferences: (sourceThreadId, references) => json('/api/platform/session-references/resolve', { method: 'POST', body: JSON.stringify({ sourceThreadId, references }) }),
    openSessionReference: (reference) => [...summaries.values()].find(item => item.reference?.threadId === reference.threadId)?.id || `history:${reference.threadId}`,

    async readSession(id, { signal } = {}) {
      if (drafts.has(id) && !targets.has(id)) { enrichDraft(id); return draftSnapshot(id); }
      let target = targets.get(id) || id;
      if (id.startsWith('history:') && !targets.has(id)) {
        const params = new URLSearchParams(sourceSession ? { sourceSession } : {});
        let value;
        try { value = await json(`/api/session-preview/${encodeURIComponent(id.slice(8))}?${params}`, { signal }); }
        catch (error) { if (!error.knownResult) throw error; value = { conversation: { turns: [] } }; }
        const snapshot = previewSnapshot(id, value, { sourceSession, title });
        const metadata = await readMetadata(value.cwd || '.').catch(() => null);
        const enriched = withMetadata({ ...snapshot, executionProfile: historyProfiles.get(id) || snapshot.executionProfile }, metadata);
        previews.set(id, enriched);
        return withProcesses(enriched);
      }
      let metadata = released.get(id) || summaries.get(id);
      let result;
      if (!metadata?.released) {
        try { result = await json(`/api/platform/sessions/${encodeURIComponent(target)}`, { signal }); }
        catch (error) {
          if (!error.knownResult) throw error;
          await adapter.listSessions({ signal }); metadata = summaries.get(id);
          if (!metadata?.released) throw error;
        }
      }
      if (metadata?.released || result?.session?.released) {
        metadata = result?.session || metadata;
        released.set(id, metadata);
        const value = await json(`/api/session-preview/${encodeURIComponent(metadata.sessionId)}`, { signal }).catch(error => {
          if (!error.knownResult) throw error;
          return { conversation: { turns: [] } };
        });
        const snapshot = { ...previewSnapshot(`history:${metadata.sessionId}`, value, { title: metadata.title }), sessionId: id, threadId: metadata.sessionId, released: true, status: 'idle', session: metadata, tokenUsage: value.tokenUsage ?? metadata.tokenUsage ?? null };
        const enriched = withMetadata(snapshot, await readMetadata(metadata.cwd || value.cwd || '.').catch(() => null));
        previews.set(id, enriched);
        return withProcesses(enriched);
      }
      const snapshot = normalizeSnapshot(result);
      const catalog = await readMetadata(result.session?.cwd || '.').catch(() => catalogs.get(result.session?.cwd || '.'));
      return withProcesses({ ...withMetadata(snapshot, catalog), sessionId: id, webSessionId: target });
    },

    async createSession(payload = {}, { idempotencyKey } = {}) {
      if (!payload.sessionId && payload.startRuntime !== true) {
        const id = `draft:${idempotencyKey || crypto.randomUUID()}`;
        if (drafts.has(id)) { enrichDraft(id); return draftSnapshot(id); }
        const draft = { ...payload, id, sessionId: id, isDraft: true, contextLabel: '', title: payload.title || '新对话', status: 'idle', updatedAt: new Date().toISOString() };
        drafts.set(id, draft);
        persistEntries('agent-web.session-drafts', drafts);
        enrichDraft(id);
        return draftSnapshot(id);
      }
      const result = await json("/api/platform/sessions", {
        method: "POST",
        body: JSON.stringify({ ...payload, idempotencyKey }),
      });
      if (result.pending) throw new Error('会话仍在恢复，请稍后重试。');
      let current = result;
      for (let attempt = 0; current.session?.ready === false && attempt < 150; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        current = await json(`/api/platform/sessions/${encodeURIComponent(result.session.id)}`);
      }
      if (current.session?.ready === false) throw new Error('会话仍在启动，请稍后重试。');
      return normalizeSnapshot(current);
    },

    async execute(id, action, payload = {}, { idempotencyKey } = {}) {
      if (action === 'loadTechnicalDetails') {
        const snapshot = await adapter.readSession(id);
        const cached = processes.get(`${snapshot.threadId}:${payload.turnId}`);
        if (cached) return { items: cached };
        const result = await json(`/api/platform/threads/${encodeURIComponent(snapshot.threadId)}/process/${encodeURIComponent(payload.turnId)}`);
        processes.set(`${snapshot.threadId}:${payload.turnId}`, result.items || []);
        if (processes.size > 50) processes.delete(processes.keys().next().value);
        return result;
      }
      if (released.has(id) && ['send', 'append', 'queue', 'restart'].includes(action)) {
        const metadata = released.get(id);
        await retarget(id, { sessionId: metadata.sessionId, cwd: metadata.cwd, title: metadata.title, access: metadata.access, executionProfile: previews.get(id)?.executionProfile }, `recover:${idempotencyKey}`);
      }
      if (id.startsWith('history:') && !targets.has(id)) {
        if (sourceSession) throw new Error('子 Agent 预览为只读。');
        if (['favorite', 'archive'].includes(action)) return json(`/api/codex-sessions/${encodeURIComponent(id.slice(8))}/${action}`, { method: 'PUT', body: JSON.stringify(payload) });
        if (action === 'executionProfile') { const profile = { ...previews.get(id)?.executionProfile, ...(payload.executionProfile || payload) }; historyProfiles.set(id, profile); return { executionProfile: profile }; }
        if (action === 'readContext') return { tokenUsage: (await adapter.readSession(id)).tokenUsage };
        if (action === 'models') return readMetadata(previews.get(id)?.cwd || '.');
        if (!['send', 'append', 'queue'].includes(action)) throw new Error('发送消息后才能使用会话操作。');
        const profile = historyProfiles.get(id) || previews.get(id)?.executionProfile;
        if (profile) rememberPendingProfile(id, profile);
        const created = await adapter.createSession({ sessionId: id.slice(8), access: serverAccess(profile?.accessMode || payload.access || 'full') }, { idempotencyKey: `resume:${id.slice(8)}` });
        bindTarget(id, created.sessionId);
        historySubscriptions.get(id)?.(); historySubscriptions.delete(id);
        const waiting = draftSubscriptions.get(id);
        if (waiting) waiting.cleanup = adapter.subscribeSession(id, waiting.options);
      }
      if (drafts.has(id) && !targets.has(id)) {
        if (['executionProfile', 'favorite', 'archive', 'rename'].includes(action)) {
          const current = drafts.get(id);
          const patch = action === 'executionProfile' ? { executionProfile: { ...draftSnapshot(id).executionProfile, ...(payload.executionProfile || payload) } }
            : action === 'favorite' ? { favorited: Boolean(payload.favorited) } : action === 'archive' ? { archived: Boolean(payload.archived) } : { title: payload.title || current.title };
          drafts.set(id, { ...current, ...patch }); persistEntries('agent-web.session-drafts', drafts);
          draftSubscriptions.get(id)?.options.onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: draftSnapshot(id) });
          return patch;
        }
        if (action === 'readContext' || action === 'models') { enrichDraft(id); return action === 'models' ? catalogs.get(drafts.get(id).cwd || '.') || {} : { tokenUsage: draftSnapshot(id).tokenUsage, isDraft: true }; }
        if (!['send', 'append', 'queue'].includes(action)) throw new Error('先发送一条消息，再使用会话工具。');
        if (!launches.has(id)) {
          const launch = (async () => {
            const draft = drafts.get(id);
            rememberPendingProfile(id, draftSnapshot(id).executionProfile);
            const created = await adapter.createSession({ ...draft, sessionId: '', access: serverAccess(pendingProfiles.get(id).accessMode), startRuntime: true }, { idempotencyKey: `launch:${id.slice(6)}` });
            bindTarget(id, created.sessionId);
            const waiting = draftSubscriptions.get(id);
            if (waiting) waiting.cleanup = adapter.subscribeSession(id, waiting.options);
          })().finally(() => launches.delete(id));
          launches.set(id, launch);
        }
        await launches.get(id);
      }
      const target = targets.get(id) || id;
      if (pendingProfiles.has(id) && ['send', 'append', 'queue'].includes(action)) {
        if (!profileApplications.has(id)) {
          const applying = json(`/api/platform/sessions/${encodeURIComponent(target)}/actions/executionProfile`, { method: 'POST', body: JSON.stringify({ ...pendingProfiles.get(id), idempotencyKey: `profile:${target}` }) })
            .then(result => { if (result.pending) throw new Error('执行设置仍在应用，请稍后重试。'); forgetPendingProfile(id); })
            .finally(() => profileApplications.delete(id));
          profileApplications.set(id, applying);
        }
        await profileApplications.get(id);
      }
      if (action === 'rename') {
        const snapshot = await adapter.readSession(id);
        return json(`/api/codex-sessions/${encodeURIComponent(snapshot.threadId)}/title`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      if (action === 'restart') {
        const { session } = await json(`/api/sessions/${encodeURIComponent(target)}/restart`, { method: 'POST' });
        await retarget(id, { ...session, cwd: summaries.get(id)?.cwd || '.' }, `restart:${idempotencyKey}`);
        return { accepted: true };
      }
      if (action === 'end') return json(`/api/sessions/${encodeURIComponent(target)}/end`, { method: 'POST' });
      if (['favorite', 'archive'].includes(action)) {
        const snapshot = await adapter.readSession(id);
        return json(`/api/codex-sessions/${encodeURIComponent(snapshot.threadId)}/${action}`, { method: 'PUT', body: JSON.stringify(payload) });
      }
      if (['deleteQueuedTurn', 'executionProfile', 'compact', 'readContext', 'models'].includes(action)) {
        const result = await json(`/api/platform/sessions/${encodeURIComponent(target)}/actions/${action}`, { method: action === 'readContext' || action === 'models' ? 'GET' : 'POST', ...(action === 'readContext' || action === 'models' ? {} : { body: JSON.stringify({ ...payload, idempotencyKey }) }) });
        if (action === 'executionProfile') forgetPendingProfile(id);
        return result;
      }
      if (action === 'raw') {
        const connection = await ensureConnection(target);
        const responseTypes = ['command', 'session-tree'].includes(payload.type) ? ['app-command-result'] : payload.type === 'side-chat-open' ? ['side-chat-state'] : ['subagents-list', 'realtime-voices'].includes(payload.type) ? ['app-command-result', 'realtime-voices'] : ['control-ack'];
        // Streaming audio carries no request receipt.
        if (payload.type === 'realtime-audio') return connection.sendUnacknowledged(payload);
        return connection.send(payload, { idempotencyKey, responseTypes });
      }
      if (action === "fork") {
        return json(`/api/sessions/${encodeURIComponent(target)}/fork`, {
          method: "POST",
          body: JSON.stringify({ lastTurnId: payload.turnId, itemId: payload.itemId, idempotencyKey }),
        });
      }
      const connection = await ensureConnection(target);
      const command = ['send', 'append'].includes(action) ? String(payload.text || '').trim().split(/\s+/)[0] : '';
      if (command === '/memories') { globalThis.AgentMemories?.open?.(); return { accepted: true }; }
      if (['/status', '/usage', '/model', '/permissions', '/fast', '/skills', '/goal', '/rename', '/compact', '/diff', '/review', '/mcp', '/plugins', '/hooks'].includes(command)) {
        const result = await connection.send({ type: 'command', data: payload.text }, { idempotencyKey, responseTypes: ['app-command-result'] });
        globalThis.dispatchEvent?.(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: id, panel: 'command', result } }));
        return result;
      }
      const message = actionMessage(action, { ...payload, notificationApp: notificationTarget.app, notificationDeviceId: notificationTarget.deviceId }, idempotencyKey);
      if (!message) throw new Error(`Unsupported Agent Web session action: ${action}`);
      return connection.send(message, { idempotencyKey });
    },

    subscribeSession(id, { onEvent, onConnection, signal, afterRevision } = {}) {
      if (released.has(id) || ((drafts.has(id) || id.startsWith('history:')) && !targets.has(id))) {
        const poll = id.startsWith('history:') || released.has(id) ? setInterval(async () => {
          try { const snapshot = await adapter.readSession(id, { signal }); onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: snapshot }); } catch { /* Next interval recovers the read-only view. */ }
        }, sourceSession ? 2000 : 5000) : null;
        if (poll) historySubscriptions.set(id, () => clearInterval(poll));
        const waiting = { options: { onEvent, onConnection, signal, afterRevision }, cleanup: null };
        draftSubscriptions.set(id, waiting);
        if (drafts.has(id)) queueMicrotask(() => {
          if (draftSubscriptions.get(id) === waiting && !signal?.aborted) onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: draftSnapshot(id) });
        });
        const cleanup = () => { if (poll) clearInterval(poll); waiting.cleanup?.(); draftSubscriptions.delete(id); historySubscriptions.delete(id); };
        signal?.addEventListener('abort', cleanup, { once: true });
        return cleanup;
      }
      const target = targets.get(id) || id;
      const connection = connections.get(target) || createAgentWebConnection(target, { clientId });
      connections.set(target, connection);
      const relay = (event) => onEvent?.({ ...event, sessionId: id });
      const relayState = (state) => onConnection?.(state);
      connection.listeners.add(relay); connection.stateListeners.add(relayState);
      relayState(connection.state);
      let stopped = false;
      const waiting = { options: { onEvent, onConnection, signal, afterRevision }, cleanup: null };
      const cleanup = () => {
        if (stopped) return; stopped = true;
        connection.listeners.delete(relay); connection.stateListeners.delete(relayState);
        connection.dispose(); connections.delete(target);
        if (draftSubscriptions.get(id) === waiting) draftSubscriptions.delete(id);
      };
      waiting.cleanup = cleanup; draftSubscriptions.set(id, waiting);
      signal?.addEventListener('abort', cleanup, { once: true });
      return cleanup;
    },

    patchSummary(summaries, snapshot) {
      return summaries.map((summary) => summary.id === snapshot.sessionId ? { ...summary, title: snapshot.title, status: snapshot.status, updatedAt: snapshot.session?.lastActivityAt || summary.updatedAt, threadId: snapshot.threadId } : summary);
    },

    applyEvent(snapshot, event) {
      if (event.type === 'status' && event.payload?.released) released.set(snapshot.sessionId, event.payload);
      const next = applyAgentWebEvent(snapshot, event);
      const catalog = catalogs.get(next.session?.cwd || next.cwd || '.');
      return withMetadata(next, catalog);
    },

    async loadHistory(id, options = {}) {
      if (previews.has(id)) {
        const previous = previews.get(id);
        if (!previous.turnsCursor) return previous;
        const threadId = previous.threadId || id.slice(8);
        const params = new URLSearchParams({ before: previous.turnsCursor, ...(sourceSession ? { sourceSession } : {}) });
        const page = previewSnapshot(`history:${threadId}`, await json(`/api/session-preview/${encodeURIComponent(threadId)}?${params}`), { sourceSession, title: previous.title });
        const items = [...page.items, ...previous.items].filter((item, index, values) => values.findIndex(value => value.id === item.id) === index);
        const merged = { ...normalizeSnapshot({ session: { ...previous.session, id, sessionId: threadId }, items }), ...page, sessionId: id, items,
          messages: [...page.messages, ...previous.messages].filter((item, index, values) => values.findIndex(value => value.id === item.id) === index),
          technicalItems: [...page.technicalItems, ...previous.technicalItems].filter((item, index, values) => values.findIndex(value => value.id === item.id) === index) };
        previews.set(id, merged); return merged;
      }
      await adapter.execute(id, "loadHistory", options);
      return adapter.readSession(id);
    },

    async markResultRead(id, turnId) {
      const snapshot = await adapter.readSession(id);
      if (!snapshot.threadId || !turnId) return;
      await json(`/api/codex-sessions/${encodeURIComponent(snapshot.threadId)}/viewed`, {
        method: "POST",
        body: JSON.stringify({ turnId }),
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      for (const connection of connections.values()) connection.dispose();
      connections.clear();
      for (const stop of historySubscriptions.values()) stop();
      historySubscriptions.clear();
      listeners.clear();
    },
  };
  return adapter;

  function rememberPendingProfile(id, profile) { pendingProfiles.set(id, profile); persistEntries('agent-web.pending-profiles', pendingProfiles); }
  function forgetPendingProfile(id) { pendingProfiles.delete(id); persistEntries('agent-web.pending-profiles', pendingProfiles); }

  function readMetadata(cwd) {
    if (catalogs.has(cwd)) return Promise.resolve(catalogs.get(cwd));
    if (metadataReads.has(cwd)) return metadataReads.get(cwd);
    const promise = json(`/api/platform/session-metadata?${new URLSearchParams({ cwd })}`).then(value => { catalogs.set(cwd, value); return value; }).finally(() => metadataReads.delete(cwd));
    metadataReads.set(cwd, promise); return promise;
  }
  function enrichDraft(id) {
    const cwd = drafts.get(id).cwd || '.';
    if (catalogs.has(cwd)) return;
    void readMetadata(cwd).then(() => {
      if (!targets.has(id) && drafts.has(id)) draftSubscriptions.get(id)?.options.onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: draftSnapshot(id) });
    }).catch(() => {});
  }
  function draftSnapshot(id) {
    const draft = drafts.get(id);
    const metadata = catalogs.get(draft.cwd || '.');
    return { ...withMetadata({ ...draft, sessionId: id, status: 'idle', messages: [], technicalItems: [], executionProfile: {
      model: '', reasoningEffort: '', accessMode: draft.access === 'safe' || draft.access === 'restricted' ? 'restricted' : 'full', ...draft.executionProfile,
    } }, metadata), tokenUsage: metadata?.modelContextWindow > 0 ? { contextUsedTokens: 0, modelContextWindow: metadata.modelContextWindow } : null };
  }
  async function retarget(id, payload, key) {
    const waiting = draftSubscriptions.get(id);
    waiting?.cleanup?.();
    const created = await adapter.createSession(payload, { idempotencyKey: key });
    bindTarget(id, created.sessionId); released.delete(id);
    if (payload.executionProfile) rememberPendingProfile(id, payload.executionProfile);
    if (waiting) adapter.subscribeSession(id, waiting.options);
  }
  function bindTarget(id, target) { targets.set(id, target); persistEntries('agent-web.session-aliases', targets); }

  async function ensureConnection(id, { afterRevision } = {}) {
    const existing = connections.get(id);
    if (existing) return existing.ready;
    const connection = createAgentWebConnection(id, { afterRevision, clientId });
    connection.listeners.add((event) => emit(event));
    connections.set(id, connection);
    try {
      await connection.ready;
      return connection;
    } catch (error) {
      connections.delete(id);
      throw error;
    }
  }
}

function actionMessage(action, payload, idempotencyKey) {
  const data = { idempotencyKey, notificationApp: payload.notificationApp, notificationDeviceId: payload.notificationDeviceId };
  if (action === "send" || action === "append" || action === "queue") return { ...data, type: "submit", data: payload.text || payload.prompt || "", attachments: payload.attachments || [], references: payload.references || [], deliveryMode: action === "queue" ? "queue" : "auto" };
  if (action === "respond" || action === "approve" || action === "decline") return { ...data, type: "agent-response", requestId: payload.requestId || payload.token, decision: payload.decision || (action === "decline" ? "decline" : "accept"), answers: payload.answers, expectedTurnId: payload.expectedTurnId };
  if (action === "stop") return { ...data, type: "interrupt-turn", expectedTurnId: payload.expectedTurnId };
  if (action === "resume") return { ...data, type: "resume-interrupted", expectedTurnId: payload.expectedTurnId };
  if (action === "editFork") return { ...data, type: "edit-and-fork", data: payload.text || "", attachments: payload.attachments || [], references: payload.references || [], turnId: payload.turnId, itemId: payload.itemId };
  if (action === "loadHistory") return { ...data, type: "load-app-history" };
  if (action === "sideChat") return { ...data, type: "side-chat-submit", data: payload.text || "" };
  if (action === "realtime") return { ...data, type: "realtime-start", ...payload };
  return null;
}

export function normalizeSnapshot(value = {}) {
  const session = value.session || value;
  const items = Array.isArray(value.transcript?.items) ? value.transcript.items : Array.isArray(value.items) ? value.items : [];
  return {
    sessionId: String(session.id || session.sessionId || ""),
    isDraft: false,
    threadId: String(session.sessionId || ""),
    session: normalizeSession(session),
    items,
    ...presentationFromAgentWeb(session, items, value.pendingRequests),
    activeTurnId: session.turnState?.turnId || "",
    revision: Number(value.revision ?? session.sessionRevision ?? session.outputRevision ?? 0),
    tokenUsage: session.tokenUsage ?? null,
    realtime: value.realtime || session.realtime,
    sideChat: value.sideChat || session.sideChat,
    subagents: value.subagents || session.subagents || [],
    hasEarlierTurns: Boolean(value.transcript?.hasEarlierTurns ?? value.hasEarlierTurns),
  };
}

function presentationFromAgentWeb(session, items, pendingRequests = []) {
  const messages = [];
  const technicalItems = [];
  const turnMetadata = new Map();
  for (const item of items) {
    const turnId = String(item?.turnId || '');
    if (turnId && !turnMetadata.has(turnId)) turnMetadata.set(turnId, { turnId, turnKey: turnId, startedAt: item.turnStartedAt || null });
    const type = String(item?.type || 'notice');
    const phase = String(item?.phase || '');
    if (type === 'user' || (type === 'assistant' && ['final_answer', 'async_question', 'async_message'].includes(phase))) {
      messages.push({
        id: String(item.id || `${type}-${messages.length}`),
        role: type === 'user' ? 'user' : 'assistant',
        content: type === 'user' ? parseSessionReferenceEnvelopes(item.text).text : String(item.text || ''),
        references: item.references || (type === 'user' ? parseSessionReferenceEnvelopes(item.text).references : []), turnId, turnKey: turnId,
        turnStatus: String(item.turnStatus || ''),
        canEdit: type === 'user', canFork: type === 'user',
        attachments: (item.attachments || []).map((attachment) => ({ id: attachment.path, name: attachment.originalName, path: attachment.path, mimeType: attachment.mime, size: attachment.size })),
      });
    } else {
      technicalItems.push({ id: String(item.id || `technical-${technicalItems.length}`), title: item.label || type, type: technicalType(type), text: String(item.text || ''), detail: String(item.detail || ''), output: String(item.output || ''), status: item.status || '', turnId, turnKey: turnId,
        media: item.type === 'tool' && item.label === '查看图片' ? [{ kind: 'image', src: `/api/session-image/${encodeURIComponent(session.id)}/${encodeURIComponent(item.id)}?turnId=${encodeURIComponent(turnId)}`, alt: item.text || '图片' }] : item.media || [] });
    }
  }
  const turnState = session.turnState || {};
  return {
    title: session.title || 'New Codex session',
    contextLabel: '',
    status: session.released ? 'idle' : pendingRequests?.length ? 'waiting' : session.ready === false ? 'connecting' : turnState.active ? 'running' : turnState.interrupted ? 'interrupted' : 'idle',
    interrupted: Boolean(turnState.interrupted),
    released: Boolean(session.released),
    tokenUsage: session.tokenUsage ?? null,
    activityKind: turnState.stopping ? 'stopping' : '',
    messages,
    technicalItems,
    technicalDetailsAvailable: [...new Set(items.filter(item => item.historical && item.turnId).map(item => item.turnId))],
    turnMetadata: [...turnMetadata.values()],
    pendingRequests: (pendingRequests || []).map((request) => ({ ...request, token: request.token || request.requestId, requestId: request.requestId || request.token })),
    queuedTurns: (turnState.queuedTurns || []).map((turn) => ({ ...turn, prompt: turn.text || turn.prompt || '' })),
    hasEarlierTurns: Boolean(session.hasEarlierTurns),
    historyLoading: Boolean(session.loadingEarlier),
    executionProfile: { model: session.model || '', reasoningEffort: session.reasoningEffort || '', accessMode: session.access === 'full' ? 'full' : 'restricted', serviceTier: session.serviceTier === 'priority' ? 'priority' : null },
  };
}

function technicalType(type) {
  if (type === 'command') return 'command';
  if (type === 'tool' || type === 'commandExecution') return 'tool';
  if (type === 'file') return 'file';
  return 'assistant';
}

export function applyAgentWebEvent(snapshot = {}, event = {}) {
  const payload = event.payload || {};
  if (event.type === 'preview-snapshot') return payload;
  if (event.type === "status") return { ...snapshot, ...normalizeSnapshot({ ...snapshot, session: payload, items: snapshot.items }), sessionId: snapshot.sessionId };
  if (event.type === "app-transcript") return { ...snapshot, ...normalizeSnapshot({ ...snapshot, session: snapshot.session, transcript: payload }), sessionId: snapshot.sessionId };
  if (event.type === "app-transcript-upsert") {
    const item = payload.item || payload;
    const items = [...(snapshot.items || [])];
    const index = items.findIndex(current => current.id === item?.id);
    if (item && index >= 0) items[index] = item;
    else if (item) items.push(item);
    return { ...snapshot, ...normalizeSnapshot({ ...snapshot, session: snapshot.session, items }), sessionId: snapshot.sessionId };
  }
  if (event.type === 'app-transcript-delta') {
    const items = (snapshot.items || []).map((item) => item.id === payload.id ? { ...item, [payload.field || 'text']: `${item[payload.field || 'text'] || ''}${payload.delta || ''}` } : item);
    return { ...snapshot, ...normalizeSnapshot({ ...snapshot, session: snapshot.session, items }), sessionId: snapshot.sessionId };
  }
  if (event.type === 'side-chat-state') return { ...snapshot, sideChat: payload };
  if (event.type === 'realtime-state') return { ...snapshot, realtime: payload, realtimeEvent: event };
  if (event.type.startsWith('realtime-')) return { ...snapshot, realtimeEvent: event };
  if (event.type === 'app-command-result' && payload.kind === 'subagents') return { ...snapshot, subagents: payload.agents || [] };
  if (event.type === 'app-history-state') return { ...snapshot, historyLoading: Boolean(payload.loadingEarlier) };
  if (event.type === "agent-request") return { ...snapshot, pendingRequests: [...(snapshot.pendingRequests || []), { ...payload, token: payload.token || payload.requestId }] };
  if (event.type === "agent-request-resolved") return { ...snapshot, pendingRequests: (snapshot.pendingRequests || []).filter((request) => request.requestId !== payload.requestId) };
  if (event.type === "replay") return { ...snapshot, revision: Math.max(Number(snapshot.revision || 0), Number(payload.revision || 0)) };
  return snapshot;
}

function normalizeSession(session = {}) {
  return {
    ...session,
    id: String(session.id || session.sessionId || ""),
    sessionId: String(session.sessionId || session.id || ""),
    title: session.title || "New Codex session",
    contextLabel: '',
    updatedAt: session.lastActivityAt || session.updatedAt || session.startedAt,
    status: session.released ? 'released' : session.pendingServerRequestCount ? 'waiting' : session.turnState?.active ? "running" : session.turnState?.interrupted ? "interrupted" : session.resultState === 'unread' || session.hasUnreadResult ? 'unread' : "idle",
  };
}

async function json(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error?.message || body.error || `Request failed (${response.status}).`), { knownResult: response.status >= 400 && response.status < 500 });
  return body;
}

function browserClientId() {
  const key = "agent_terminal_platform_client_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
}

function storedEntries(key) {
  try { return new Map(JSON.parse(globalThis.sessionStorage?.getItem(key) || '[]').filter(value => Array.isArray(value) && value.length === 2)); } catch { return new Map(); }
}
function persistEntries(key, values) {
  try { globalThis.sessionStorage?.setItem(key, JSON.stringify([...values].slice(-50))); } catch { /* In-memory Session state remains usable. */ }
}

export function previewSnapshot(id, value, { sourceSession = '', title = '' } = {}) {
  const items = value.transcript?.items || (value.conversation?.turns || []).flatMap((turn) => [
    ...(turn.user ? [{ id: `${turn.id}-user`, type: 'user', text: turn.user, turnId: turn.id, turnStatus: 'completed', historical: true }] : []),
    ...(turn.assistant || []).map((item, index) => ({ ...item, id: item.id || `${turn.id}-assistant-${index}`, type: 'assistant', turnId: turn.id, phase: item.phase || 'final_answer', historical: true })),
  ]);
  return { ...normalizeSnapshot({ session: { id, sessionId: id.slice(8), cwd: value.cwd, model: value.model, reasoningEffort: value.reasoningEffort, tokenUsage: value.tokenUsage, access: value.access || 'full', title: title || value.preview?.title || '历史对话', ready: true, turnState: { active: Boolean(value.active) } }, items }),
    cwd: value.cwd, readOnly: Boolean(sourceSession), composerDisabled: Boolean(sourceSession), preview: true, turnsCursor: value.conversation?.nextCursor || null, hasEarlierTurns: Boolean(value.conversation?.hasEarlier || value.transcript?.hasEarlierTurns) };
}

function serverAccess(value) { return value === 'full' ? 'full' : 'safe'; }

// Shared UI views contain presentation fields; product usage remains in the Host snapshot.
export function agentWebSessionContext(controller, view) {
  const snapshot = controller.getSnapshot().session;
  return {
    usage: snapshot?.sessionId === view.sessionId ? snapshot.tokenUsage ?? null : null,
    isDraft: Boolean(view.isDraft),
    onRead: () => controller.execute('readContext', {}, { sessionId: view.sessionId }),
    onCompact: view.isDraft ? undefined : () => controller.execute('compact', {}, { sessionId: view.sessionId }),
  };
}

function withMetadata(snapshot, catalog) {
  const profile = snapshot.executionProfile || {};
  return { ...snapshot,
    executionProfile: { ...profile, model: profile.model || catalog?.currentModel || '', reasoningEffort: profile.reasoningEffort || catalog?.currentReasoningEffort || '',
      serviceTier: profile.serviceTier === undefined ? catalog?.serviceTier || null : profile.serviceTier },
    models: (catalog?.models || snapshot.models || []).map(model => ({ ...model, label: model.name || model.label, serviceTiers: [{ id: 'priority', label: 'Fast', description: '优先处理请求' }] })),
    accessModes: [{ id: 'full', label: '完全访问' }, { id: 'restricted', label: '按需确认' }],
  };
}
