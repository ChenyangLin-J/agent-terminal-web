import { parseSessionReferenceEnvelopes } from '@agent-workbench/platform/session-references';
import { mergeSessionHostSnapshot } from '@agent-workbench/platform/session-host';
import { createAgentWebConnection } from './agent-web-connection.js';
import { platformFileResourceUrl } from './platform-agent-web-resources.js';
const WS_OPEN = 1;
const RETRYABLE_ACTIONS = new Set([
  "send", "append", "queue", "respond", "approve", "decline", "stop", "resume", "editFork", "fork",
]);

export function createAgentWebSessionAdapter({ clientId = browserClientId(), sourceSession = '', title = '', notificationTarget = {}, lazyMetadata = false } = {}) {
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
  const processReads = new Map();
  const threadBySession = new Map();
  const processSizes = new Map();
  const previewRefreshers = new Map();
  let processBytes = 0;
  const withProcesses = (snapshot) => {
    const entries = [...processes].filter(([key]) => key.startsWith(`${snapshot.threadId}:`));
    if (!entries.length) return snapshot;
    const loadedTurns = new Set(entries.map(([key]) => key.slice(snapshot.threadId.length + 1)));
    const loaded = entries.flatMap(([, items]) => items);
    const activeTurnId = snapshot.session?.turnState?.active ? snapshot.session.turnState.turnId : null;
    // Disk previews and process reads use different item IDs for the same progress.
    // Replace historical technical items only; public messages and live items stay.
    const base = (snapshot.items || []).filter(item => {
      if (!loadedTurns.has(item.turnId) || isPublicMessage(item)) return true;
      if (item.historical) return false;
      // Restored native progress may lack the historical flag. Drop an identical
      // completed copy, while preserving the active turn and any newer text.
      return item.turnId === activeTurnId || item.type !== 'assistant' || item.phase !== 'commentary'
        || !loaded.some(saved => saved.turnId === item.turnId && saved.type === 'assistant' && saved.phase === 'commentary' && saved.text === item.text);
    });
    const items = [...new Map([...base, ...loaded].map(item => [item.id, item])).values()];
    const presentation = presentationFromAgentWeb(snapshot.session || {}, items, snapshot.pendingRequests);
    return { ...snapshot, items, messages: presentation.messages, technicalItems: presentation.technicalItems, technicalDetailsAvailable: [...new Set([...(snapshot.technicalDetailsAvailable || []), ...presentation.technicalDetailsAvailable])], technicalDetailsLoaded: [...loadedTurns].filter(id => id !== activeTurnId), turnMetadata: presentation.turnMetadata };
  };

  const emit = (event) => listeners.forEach((listener) => listener(event));

  const adapter = {
    getSnapshotCacheKey(snapshot, rows) {
      const id = snapshot.sessionId;
      const summary = rows.find(item => item.id === id) || rows.find(item => snapshot.threadId && (item.threadId || item.sessionId) === snapshot.threadId);
      if (!summary || !['idle', 'unread'].includes(summary.status) || snapshot.status !== 'idle'
        || snapshot.session?.turnState?.active || summary.turnState?.active || summary.pendingServerRequestCount
        || snapshot.pendingRequests?.length || (summary.ready === false && !snapshot.preview)) return null;
      const target = targets.get(id) || id;
      if (snapshot.webSessionId && snapshot.webSessionId !== target) return null;
      if (snapshot.preview && targets.has(id)) return null;
      if (summary.attachmentId && snapshot.webSessionId && summary.attachmentId !== snapshot.webSessionId) return null;
      // Client attach/detach and model metadata advance sessionRevision without
      // changing conversation data. Attest its semantic output/lifecycle version
      // so merely switching away cannot invalidate an otherwise verified body.
      return JSON.stringify([snapshot.threadId, snapshot.webSessionId || target,
        summary.outputRevision ?? null, summary.updatedAt || '', summary.status || '',
        summary.turnState?.turnId || '', summary.turnState?.lastCompletedTurnId || summary.lastCompletedTurnId || '',
        Boolean(summary.hasUnreadResult)]);
    },
    submissionMessage(action, payload) {
      if (!['send', 'append', 'queue'].includes(action) || /^\/(?:memories|status|usage|model|permissions|fast|skills|goal|rename|compact|diff|review|mcp|plugins|hooks)(?:\s|$)/.test(payload.text || '')) return null;
      return { role: 'user', content: payload.text || payload.prompt || '', references: payload.references || [],
        attachments: (payload.attachments || []).map(item => ({ ...item, id: item.path || item.id, name: item.originalName || item.name, mimeType: item.mime || item.mimeType })) };
    },
    isSubmissionEcho(snapshot, submission) {
      const baseline = new Set(submission.baseline);
      const turnId = submission.result?.deliveryMode === 'queue' ? '' : submission.result?.turnState?.turnId;
      return (snapshot.messages || []).some(message => message.role === 'user' && !message.submissionId
        && (message.id === submission.idempotencyKey || (!baseline.has(message.id) && message.content === submission.message.content
        && (!turnId || !message.turnId || message.turnId === turnId)
        && JSON.stringify((message.references || []).map(item => item.threadId || item.id).sort()) === JSON.stringify((submission.message.references || []).map(item => item.threadId || item.id).sort())
        && JSON.stringify((message.attachments || []).map(item => item.path || item.id).sort()) === JSON.stringify((submission.message.attachments || []).map(item => item.path || item.id).sort()))));
    },
    reconcileSelection(snapshot, rows) {
      const id = snapshot.sessionId;
      const summary = rows.find(item => item.id === id) || rows.find(item => snapshot.threadId && (item.threadId || item.sessionId) === snapshot.threadId);
      if (summary) adoptCatalogBinding(id, summary);
      const target = targets.get(id) || id;
      const bindingChanged = Boolean(snapshot.webSessionId && snapshot.webSessionId !== target)
        || (Boolean(targets.has(id)) && Boolean(snapshot.preview))
        || (Boolean(snapshot.released) && !snapshot.preview);
      const snapshotRequired = summary && catalogVersion(summary) !== catalogVersion(snapshot.session || {})
        && (Number(summary.sessionRevision ?? -1) > Number(snapshot.revision ?? -1)
          || Date.parse(summary.updatedAt || 0) > Date.parse(snapshot.session?.lastActivityAt || 0));
      return { bindingChanged, snapshotRequired: Boolean(snapshotRequired) };
    },
    resolveSessionId: (id) => [...targets].find(([, target]) => target === id)?.[0] || id,
    async listSessions({ query = "", archived = false, cursor = null, signal } = {}) {
      const params = new URLSearchParams({ q: query, archived: archived ? '1' : '0', limit: '20' });
      if (cursor) params.set('cursor', cursor);
      const result = await json(`/api/platform/sessions?${params}`, { signal });
      const aliases = new Map([...targets].map(([alias, target]) => [target, alias]));
      const values = (result.sessions || []).map((value) => normalizeSession({ ...value, attachmentId: value.id, id: aliases.get(value.id) || value.id }));
      for (const value of values) {
        const previous = summaries.get(value.id);
        summaries.set(value.id, value);
        if (previous && (previous.updatedAt !== value.updatedAt || previous.status !== value.status)) previewRefreshers.get(value.id)?.();
      }
      for (const draft of drafts.values()) if (!targets.has(draft.id) && (archived || !draft.archived) && (!query || draft.title.toLowerCase().includes(query.toLowerCase()))) values.unshift(draft);
      return { ...result, sessions: values };
    },

    applyCatalogEvent(current, event) {
      const incoming = normalizeSession(event?.summary || event?.payload || {});
      const id = catalogIdentity(current, incoming, targets);
      if (!id) return current;
      const existing = current.find((item) => item.id === id);
      if (!catalogEventIsNewer(existing, incoming, event)) return current;
      adoptCatalogBinding(id, incoming);
      summaries.set(id, { ...incoming, id });
      return sortSessionSummaries(current.map((item) => item.id === id ? { ...item, ...incoming, id } : item));
    },

    async reconcileCatalog(current = [], { signal, getCurrent = () => current } = {}) {
      const wanted = new Set(current.filter((item) => !item.isDraft).map((item) => item.threadId || item.sessionId).filter(Boolean));
      if (!wanted.size) return current;
      const found = new Map();
      let cursor = null;
      do {
        const params = new URLSearchParams({ archived: '1', limit: '20' });
        if (cursor) params.set('cursor', cursor);
        const page = await json(`/api/platform/sessions?${params}`, { signal });
        for (const raw of page.sessions || []) {
          const value = normalizeSession(raw);
          const threadId = value.threadId || value.sessionId;
          if (wanted.has(threadId)) found.set(threadId, value);
        }
        cursor = page.nextCursor || null;
      } while (cursor && found.size < wanted.size);
      const latest = getCurrent();
      const baseline = new Map(current.map((item) => [item.id, catalogVersion(item)]));
      const reconciled = latest.map((item) => {
        const incoming = found.get(item.threadId || item.sessionId);
        if (!incoming) return item;
        // A status event received during this read is newer than the catalogue
        // snapshot, even when the HTTP response resolves afterwards.
        if (baseline.has(item.id) && baseline.get(item.id) !== catalogVersion(item)) return item;
        const next = { ...item, ...incoming, id: item.id, sessionRevision: incoming.sessionRevision };
        adoptCatalogBinding(item.id, incoming);
        summaries.set(item.id, next);
        return next;
      });
      return sortSessionSummaries(reconciled);
    },

    async searchSessionReferences(id, query) {
      const result = await adapter.listSessions({ query });
      const source = previews.get(id)?.threadId || summaries.get(id)?.threadId;
      return { references: result.sessions.map(item => item.reference).filter(item => item && item.threadId !== source && !item.archived) };
    },
    async loadExecutionOptions(id, { cwd: currentCwd } = {}) {
      const snapshot = drafts.has(id) && !targets.has(id) ? draftSnapshot(id) : previews.get(id);
      const cwd = currentCwd || snapshot?.cwd || snapshot?.session?.cwd || summaries.get(id)?.cwd || '.';
      const catalog = await readMetadata(cwd);
      return withMetadata(snapshot || {}, catalog);
    },
    resolveSessionReferences: (sourceThreadId, references) => json('/api/platform/session-references/resolve', { method: 'POST', body: JSON.stringify({ sourceThreadId, references }) }),
    openSessionReference: (reference) => [...summaries.values()].find(item => item.reference?.threadId === reference.threadId)?.id || `history:${reference.threadId}`,

    async readSession(id, { signal } = {}) {
      if (drafts.has(id) && !targets.has(id)) { if (!lazyMetadata) enrichDraft(id); return draftSnapshot(id); }
      let target = targets.get(id) || id;
      if (id.startsWith('history:') && !targets.has(id)) {
        const params = new URLSearchParams(sourceSession ? { sourceSession } : {});
        let value;
        try { value = await json(`/api/session-preview/${encodeURIComponent(id.slice(8))}?${params}`, { signal }); }
        catch (error) { if (!missingSession(error)) throw error; value = { conversation: { turns: [] } }; }
        const previous = previews.get(id);
        const previewTitle = summaries.get(id)?.title || (previous?.titleIsFallback ? '' : previous?.title) || title;
        const snapshot = previewSnapshot(id, value, { sourceSession, title: previewTitle });
        const metadata = await presentationMetadata(value.cwd || '.');
        const enriched = withMetadata({ ...snapshot, executionProfile: historyProfiles.get(id) || snapshot.executionProfile }, metadata);
        if (targets.has(id)) return adapter.readSession(id, { signal });
        return rememberPreview(id, enriched);
      }
      // Once promoted, the live target owns state. Sidebar summaries may still
      // describe an older released attachment of the same native thread.
      let metadata = released.get(id) || (!targets.has(id) ? summaries.get(id) : null);
      let result;
      if (!metadata?.released) {
        try { result = await json(`/api/platform/sessions/${encodeURIComponent(target)}`, { signal }); }
        catch (error) {
          if (!missingSession(error)) throw error;
          await adapter.listSessions({ signal }); metadata = summaries.get(id);
          if (!metadata?.released) throw error;
        }
      }
      if (metadata?.released || result?.session?.released) {
        if ((targets.get(id) || id) !== target) return adapter.readSession(id, { signal });
        metadata = result?.session || metadata;
        released.set(id, metadata);
        const value = await json(`/api/session-preview/${encodeURIComponent(metadata.sessionId)}`, { signal }).catch(error => {
          if (!missingSession(error)) throw error;
          return { conversation: { turns: [] } };
        });
        const snapshot = { ...previewSnapshot(`history:${metadata.sessionId}`, value, { title: metadata.title }), sessionId: id, threadId: metadata.sessionId, released: true, status: 'idle', session: metadata, tokenUsage: value.tokenUsage ?? metadata.tokenUsage ?? null };
        const enriched = withMetadata(snapshot, await presentationMetadata(metadata.cwd || value.cwd || '.'));
        if ((targets.get(id) || id) !== target) return adapter.readSession(id, { signal });
        return rememberPreview(id, enriched);
      }
      const actualTarget = result.session?.id || target;
      if (actualTarget !== target) { bindTarget(id, actualTarget); target = actualTarget; }
      released.delete(id);
      previews.delete(id);
      const snapshot = normalizeSnapshot(result);
      const catalog = await presentationMetadata(result.session?.cwd || '.');
      if ((targets.get(id) || id) !== target) return adapter.readSession(id, { signal });
      threadBySession.set(id, snapshot.threadId);
      return withProcesses({ ...withMetadata(snapshot, catalog), sessionId: id, webSessionId: target });
    },

    async createSession(payload = {}, { idempotencyKey } = {}) {
      if (!payload.sessionId && payload.startRuntime !== true) {
        const id = `draft:${idempotencyKey || crypto.randomUUID()}`;
        if (drafts.has(id)) { if (!lazyMetadata) enrichDraft(id); return draftSnapshot(id); }
        const draft = { ...payload, id, sessionId: id, isDraft: true, contextLabel: '', title: payload.title || '新对话', status: 'idle', updatedAt: new Date().toISOString() };
        drafts.set(id, draft);
        persistEntries('agent-web.session-drafts', drafts);
        if (!lazyMetadata) enrichDraft(id);
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

    async execute(id, action, payload = {}, { idempotencyKey, signal } = {}) {
      if (action === 'loadTechnicalDetails') {
        const threadId = knownThread(id) || (await adapter.readSession(id)).threadId;
        const key = `${threadId}:${payload.turnId}`;
        if (processes.has(key)) return { items: processes.get(key) };
        if (processReads.has(key)) return processReads.get(key);
        const task = json(`/api/platform/threads/${encodeURIComponent(threadId)}/process/${encodeURIComponent(payload.turnId)}`).then(result => {
          const items = result.items || [];
          const bytes = JSON.stringify(items).length * 2;
          // Completed turns are immutable; live progress comes from its subscription.
          if (!items.some(item => item.status === 'inProgress') && bytes <= 8 * 1024 * 1024) {
            processes.set(key, items); processSizes.set(key, bytes); processBytes += bytes;
            while (processes.size > 50 || processBytes > 8 * 1024 * 1024) {
              const oldest = processes.keys().next().value;
              processBytes -= processSizes.get(oldest) || 0;
              processes.delete(oldest); processSizes.delete(oldest);
            }
            draftSubscriptions.get(id)?.options.onEvent?.({ type: 'technical-details-loaded', sessionId: id });
          }
          return { ...result, technicalItems: presentationFromAgentWeb({}, items).technicalItems };
        }).finally(() => { if (processReads.get(key) === task) processReads.delete(key); });
        processReads.set(key, task);
        return task;
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
        await retarget(id, { sessionId: id.slice(8), cwd: previews.get(id)?.cwd || '.', access: serverAccess(profile?.accessMode || payload.access || 'full'), executionProfile: profile }, `resume:${id.slice(8)}`);
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
        if (action === 'models') return readMetadata(drafts.get(id).cwd || '.');
        if (action === 'readContext') return { tokenUsage: draftSnapshot(id).tokenUsage, isDraft: true };
        if (!['send', 'append', 'queue'].includes(action)) throw new Error('先发送一条消息，再使用会话工具。');
        if (!launches.has(id)) {
          const launch = (async () => {
            const draft = drafts.get(id);
            if (lazyMetadata) await readMetadata(draft.cwd || '.');
            rememberPendingProfile(id, draftSnapshot(id).executionProfile);
            const created = await adapter.createSession({ ...draft, sessionId: '', access: serverAccess(pendingProfiles.get(id).accessMode), startRuntime: true }, { idempotencyKey: `launch:${id.slice(6)}` });
            checkAborted(signal);
            bindTarget(id, created.sessionId);
            const waiting = draftSubscriptions.get(id);
            if (waiting) waiting.cleanup = adapter.subscribeSession(id, waiting.options);
          })().finally(() => launches.delete(id));
          launches.set(id, launch);
        }
        await launches.get(id);
      }
      checkAborted(signal);
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
      checkAborted(signal);
      const message = actionMessage(action, { ...payload, notificationApp: notificationTarget.app, notificationDeviceId: notificationTarget.deviceId }, idempotencyKey);
      if (!message) throw new Error(`Unsupported Agent Web session action: ${action}`);
      return connection.send(message, { idempotencyKey, signal });
    },

    subscribeSession(id, { onEvent, onConnection, signal, afterRevision } = {}) {
      if (released.has(id) || ((drafts.has(id) || id.startsWith('history:')) && !targets.has(id))) {
        let active = true;
        let timer = null, pending = null, lastFocus = 0;
        const preview = id.startsWith('history:') || released.has(id);
        const visible = () => globalThis.document?.visibilityState !== 'hidden';
        const schedule = () => {
          clearTimeout(timer); timer = null;
          if (preview && active && !signal?.aborted && visible() && previews.get(id)?.session?.turnState?.active) timer = setTimeout(refresh, sourceSession ? 2000 : 5000);
        };
        const refresh = () => {
          if (!active || signal?.aborted || !visible()) return;
          if (pending) return pending;
          clearTimeout(timer); timer = null;
          pending = (async () => {
            try {
              const snapshot = await adapter.readSession(id, { signal });
              if (active && !signal?.aborted) onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: snapshot });
            } catch { /* Focus/source updates and active polling can retry the read. */ }
            finally { pending = null; schedule(); }
          })();
          return pending;
        };
        const focus = () => {
          if (!visible() || Date.now() - lastFocus < 250) return;
          lastFocus = Date.now(); void refresh();
        };
        const visibility = () => { if (visible()) focus(); else { clearTimeout(timer); timer = null; } };
        const stopPreview = () => {
          active = false; clearTimeout(timer);
          globalThis.removeEventListener?.('focus', focus);
          globalThis.document?.removeEventListener('visibilitychange', visibility);
          if (previewRefreshers.get(id) === refresh) previewRefreshers.delete(id);
        };
        if (preview) {
          historySubscriptions.set(id, stopPreview); previewRefreshers.set(id, refresh);
          globalThis.addEventListener?.('focus', focus);
          globalThis.document?.addEventListener('visibilitychange', visibility);
          schedule();
        }
        const waiting = { options: { onEvent, onConnection, signal, afterRevision }, cleanup: null };
        draftSubscriptions.set(id, waiting);
        if (drafts.has(id)) queueMicrotask(() => {
          if (draftSubscriptions.get(id) === waiting && !signal?.aborted) onEvent?.({ type: 'preview-snapshot', sessionId: id, payload: draftSnapshot(id) });
        });
        const cleanup = () => {
          stopPreview(); waiting.cleanup?.();
          if (draftSubscriptions.get(id) === waiting) draftSubscriptions.delete(id);
          if (historySubscriptions.get(id) === stopPreview) historySubscriptions.delete(id);
        };
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
      return summaries.map((summary) => summary.id === snapshot.sessionId ? { ...summary, title: snapshot.titleIsFallback ? summary.title : snapshot.title, status: snapshot.status, updatedAt: snapshot.session?.lastActivityAt || summary.updatedAt, threadId: snapshot.threadId } : summary);
    },

    mergeSnapshot(current, latest) {
      // Disk previews synthesize item IDs. The restored native transcript is
      // authoritative, so merging both representations would duplicate messages.
      return current.preview && !latest.preview ? latest : withProcesses(mergeSessionHostSnapshot(current, latest));
    },

    applyEvent(snapshot, event) {
      if (event.type === 'technical-details-loaded') return withProcesses(snapshot);
      if (event.type === 'status' && event.payload?.released) released.set(snapshot.sessionId, event.payload);
      const next = applyAgentWebEvent(snapshot, event);
      const catalog = catalogs.get(next.session?.cwd || next.cwd || '.');
      return withMetadata(withProcesses(next), catalog);
    },

    async loadHistory(id, options = {}) {
      if (previews.has(id)) {
        const previous = previews.get(id);
        if (!previous.turnsCursor) return withProcesses(previous);
        const threadId = previous.threadId || id.slice(8);
        const params = new URLSearchParams({ before: previous.turnsCursor, ...(sourceSession ? { sourceSession } : {}) });
        const page = previewSnapshot(`history:${threadId}`, await json(`/api/session-preview/${encodeURIComponent(threadId)}?${params}`), { sourceSession, title: previous.titleIsFallback ? '' : previous.title });
        const items = [...page.items, ...previous.items].filter((item, index, values) => values.findIndex(value => value.id === item.id) === index);
        const presentation = presentationFromAgentWeb(previous.session, items, previous.pendingRequests);
        const merged = { ...previous, ...page, session: previous.session, sessionId: id, items,
          messages: presentation.messages, technicalItems: presentation.technicalItems,
          technicalDetailsAvailable: presentation.technicalDetailsAvailable, turnMetadata: presentation.turnMetadata };
        previews.set(id, merged); return withProcesses(merged);
      }
      await adapter.execute(id, "loadHistory", options);
      return adapter.readSession(id);
    },

    async markResultRead(id, turnId) {
      const threadId = knownThread(id) || (await adapter.readSession(id)).threadId;
      if (!threadId || !turnId) return;
      await json(`/api/codex-sessions/${encodeURIComponent(threadId)}/viewed`, {
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
      previewRefreshers.clear(); processReads.clear(); processes.clear(); processSizes.clear(); threadBySession.clear(); processBytes = 0;
      listeners.clear();
    },
  };
  return adapter;

  function adoptCatalogBinding(id, summary) {
    const nativeId = knownThread(id) || summaries.get(id)?.threadId || summaries.get(id)?.sessionId;
    const incomingThread = summary.threadId || summary.sessionId;
    const incomingTarget = summary.attachmentId || summary.id;
    if (!sourceSession && nativeId && nativeId === incomingThread && !summary.released && !incomingTarget.startsWith('history:') && incomingTarget !== (targets.get(id) || id)) {
      bindTarget(id, incomingTarget); released.delete(id); previews.delete(id);
    }
  }

  function knownThread(id) { return previews.get(id)?.threadId || threadBySession.get(id) || released.get(id)?.sessionId || (id.startsWith('history:') && !targets.has(id) ? id.slice(8) : null); }

  function rememberPreview(id, snapshot) {
    const previous = previews.get(id);
    const paged = previous?.threadId === snapshot.threadId && previous.messages.length > snapshot.messages.length;
    const next = paged ? { ...mergeSessionHostSnapshot(previous, snapshot), turnsCursor: previous.turnsCursor, hasEarlierTurns: previous.hasEarlierTurns } : snapshot;
    previews.set(id, next);
    return withProcesses(next);
  }

  function rememberPendingProfile(id, profile) { pendingProfiles.set(id, profile); persistEntries('agent-web.pending-profiles', pendingProfiles); }
  function forgetPendingProfile(id) { pendingProfiles.delete(id); persistEntries('agent-web.pending-profiles', pendingProfiles); }

  function readMetadata(cwd) {
    if (catalogs.has(cwd)) return Promise.resolve(catalogs.get(cwd));
    if (metadataReads.has(cwd)) return metadataReads.get(cwd);
    const promise = json(`/api/platform/session-metadata?${new URLSearchParams({ cwd })}`).then(value => { catalogs.set(cwd, value); return value; }).finally(() => metadataReads.delete(cwd));
    metadataReads.set(cwd, promise); return promise;
  }
  function presentationMetadata(cwd) {
    return lazyMetadata ? Promise.resolve(catalogs.get(cwd)) : readMetadata(cwd).catch(() => catalogs.get(cwd));
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
    const created = await adapter.createSession(payload, { idempotencyKey: key });
    historySubscriptions.get(id)?.(); historySubscriptions.delete(id);
    waiting?.cleanup?.();
    bindTarget(id, created.sessionId); released.delete(id); previews.delete(id);
    summaries.set(id, { ...created.session, id });
    if (payload.executionProfile) rememberPendingProfile(id, payload.executionProfile);
    if (waiting && !waiting.options.signal?.aborted) waiting.cleanup = adapter.subscribeSession(id, waiting.options);
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
    preview: false,
    readOnly: false,
    composerDisabled: false,
    threadId: String(session.sessionId || ""),
    session: normalizeSession(session),
    items,
    ...presentationFromAgentWeb(session, items, value.pendingRequests),
    technicalDetailsAvailable: [...new Set([...(value.transcript?.technicalDetailsAvailable || []), ...(value.technicalDetailsAvailable || []),
      ...items.filter(item => item.historical && isNativeTurnId(item.turnId)).map(item => item.turnId)])],
    activeTurnId: session.turnState?.active ? session.turnState.turnId || "" : "",
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
    if (isPublicMessage(item)) {
      messages.push({
        id: String(item.id || `${type}-${messages.length}`),
        role: type === 'user' ? 'user' : 'assistant',
        phase: item.phase || '',
        memoryCitation: item.memoryCitation || null,
        content: type === 'user' ? parseSessionReferenceEnvelopes(item.text).text : String(item.text || ''),
        references: item.references || (type === 'user' ? parseSessionReferenceEnvelopes(item.text).references : []), turnId, turnKey: turnId,
        turnStatus: String(item.turnStatus || (turnId && session.turnState?.active && session.turnState.turnId === turnId ? 'inProgress'
          : turnId && session.turnState?.lastCompletedTurnId === turnId ? session.turnState.lastStoppedTurnId === turnId ? 'interrupted' : 'completed' : '')),
        canEdit: type === 'user', canFork: type === 'user',
        attachments: (item.attachments || []).map((attachment) => ({ id: attachment.path, name: attachment.originalName, path: attachment.path, mimeType: attachment.mime, size: attachment.size })),
      });
    } else {
      technicalItems.push({ id: String(item.id || `technical-${technicalItems.length}`), title: technicalTitle(item), type: technicalType(type), text: String(item.text || ''), detail: String(item.detail || ''), output: String(item.output || ''), status: item.status || '', turnId, turnKey: turnId,
        disclosure: item.disclosure === 'inline' || (item.type === 'tool' && item.label === '查看图片') ? 'inline' : null,
        media: item.type === 'tool' && item.label === '查看图片' ? [{ id: item.id, name: String(item.text || '').split(/[\\/]/).filter(Boolean).at(-1) || '图片', kind: 'image', src: session.id && !String(session.id).startsWith('history:') ? `/api/session-image/${encodeURIComponent(session.id)}/${encodeURIComponent(item.id)}?turnId=${encodeURIComponent(turnId)}` : platformFileResourceUrl(item.text), alt: item.text || '图片' }] : item.media || [] });
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
    technicalDetailsAvailable: [...new Set(items.filter(item => item.historical && isNativeTurnId(item.turnId)).map(item => item.turnId))],
    turnMetadata: [...turnMetadata.values()],
    pendingRequests: (pendingRequests || []).map((request) => ({ ...request, token: request.token || request.requestId, requestId: request.requestId || request.token })),
    queuedTurns: (turnState.queuedTurns || []).map((turn) => ({ ...turn, prompt: turn.text || turn.prompt || '' })),
    hasEarlierTurns: Boolean(session.hasEarlierTurns),
    historyLoading: Boolean(session.loadingEarlier),
    executionProfile: { model: session.model || '', reasoningEffort: session.reasoningEffort || '', accessMode: session.access === 'full' ? 'full' : 'restricted', serviceTier: session.serviceTier === 'priority' ? 'priority' : null },
  };
}

function isPublicMessage(item) {
  return item.type === 'user' || (item.type === 'assistant' && ['final_answer', 'async_question', 'async_message'].includes(item.phase));
}

function isNativeTurnId(value) {
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function technicalTitle(item) {
  if (item.type === 'assistant') return '进度说明';
  return item.label || ({ command: '运行命令', commandExecution: '运行命令', tool: '工具调用', file: '文件变更', plan: '执行计划' }[item.type]) || '执行信息';
}

function technicalType(type) {
  if (type === 'command') return 'command';
  if (type === 'tool' || type === 'commandExecution') return 'tool';
  if (type === 'file') return 'file';
  if (type === 'plan') return 'plan';
  return 'assistant';
}

export function applyAgentWebEvent(snapshot = {}, event = {}) {
  const payload = event.payload || {};
  if (event.type === 'preview-snapshot') return payload;
  if (event.type === "status") return { ...snapshot, ...normalizeSnapshot({ ...snapshot, session: payload, items: snapshot.items }), sessionId: snapshot.sessionId, preview: Boolean(snapshot.preview) };
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
    attachmentId: session.attachmentId || session.id,
    id: String(session.id || session.sessionId || ""),
    sessionId: String(session.sessionId || session.id || ""),
    title: session.title || "New Codex session",
    contextLabel: '',
    updatedAt: session.lastActivityAt || session.updatedAt || session.startedAt,
    status: session.pendingServerRequestCount ? 'waiting' : session.turnState?.active ? "running" : session.turnState?.interrupted ? "interrupted" : session.resultState === 'unread' || session.hasUnreadResult ? 'unread' : "idle",
  };
}

function catalogIdentity(current, incoming, targets) {
  const targetAlias = [...targets].find(([, target]) => target === incoming.id)?.[0];
  if (targetAlias && current.some((item) => item.id === targetAlias)) return targetAlias;
  if (current.some((item) => item.id === incoming.id)) return incoming.id;
  const threadId = incoming.threadId || incoming.sessionId;
  return current.find((item) => threadId && (item.threadId === threadId || item.sessionId === threadId))?.id || null;
}

function catalogEventIsNewer(current, incoming, event) {
  if (!current) return false;
  // sessionRevision is the ordering domain for status broadcasts. outputRevision
  // counts terminal output bytes/events and must never be compared with it.
  if (current.attachmentId && incoming.attachmentId && current.attachmentId !== incoming.attachmentId) {
    return !incoming.released && Date.parse(incoming.updatedAt || 0) >= Date.parse(current.updatedAt || 0);
  }
  const previousRevision = Number(current.sessionRevision ?? -1);
  const incomingRevision = Number(event?.revision ?? incoming.sessionRevision ?? -1);
  if (previousRevision >= 0 && incomingRevision >= 0) return incomingRevision > previousRevision;
  const previousTurnId = String(current.turnState?.turnId || '');
  const incomingTurnId = String(incoming.turnState?.turnId || event?.turnId || '');
  if (current.status === 'running' && incoming.status !== 'running' && previousTurnId && incomingTurnId && previousTurnId !== incomingTurnId) return false;
  return Date.parse(incoming.updatedAt || 0) >= Date.parse(current.updatedAt || 0);
}

function sortSessionSummaries(values) {
  return [...values].sort((left, right) => (Date.parse(right.updatedAt || 0) || 0) - (Date.parse(left.updatedAt || 0) || 0));
}

function catalogVersion(value = {}) {
  return JSON.stringify([
    value.sessionRevision ?? null,
    value.status || '',
    value.updatedAt || '',
    value.turnState?.turnId || '',
    Boolean(value.turnState?.active),
    Boolean(value.hasUnreadResult),
  ]);
}

async function json(url, options = {}) {
  const started = performance.now();
  const method = (options.method || 'GET').toUpperCase();
  const attempts = method === 'GET' ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    options.signal?.throwIfAborted();
    let response, headersAt, body;
    try {
      // The private gate redirects expired credentials to a different origin.
      // Keep API redirects visible instead of following them into a CORS error.
      response = await fetch(url, { ...options, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...options.headers } });
      headersAt = performance.now();
      if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
        throw Object.assign(new Error('登录已过期，请刷新页面重新登录。'), { authRequired: true, knownResult: false });
      }
      try { body = await response.json(); }
      catch (error) {
        // Preserve explicit HTTP rejection even when its error body is invalid.
        if (!response.ok && error.name !== 'AbortError' && !options.signal?.aborted) body = {};
        else throw error;
      }
    } catch (error) {
      if (error.name === 'AbortError' || options.signal?.aborted) throw options.signal?.reason || error;
      if (error.authRequired) throw error;
      const kind = error instanceof SyntaxError ? 'invalid-response' : error instanceof TypeError ? 'network' : null;
      if (!kind) throw error;
      console.info('AgentWebTiming', JSON.stringify({ phase: 'request-failed', method, attempt, kind, retrying: attempt < attempts }));
      if (attempt < attempts) { await retryRead(options.signal); continue; }
      throw Object.assign(new Error(kind === 'invalid-response' ? '服务响应异常，请重试。' : '网络连接中断，请重试。', { cause: error }), { knownResult: false, transportFailure: kind });
    }
    if (/^\/api\/(platform\/sessions\/[^/?]+|session-preview\/[^/?]+)(?:\?|$)/.test(url)) {
      console.info('AgentWebTiming', JSON.stringify({ phase: 'snapshot-read', attempts: attempt,
        headersMs: Math.round(headersAt - started), bodyMs: Math.round(performance.now() - headersAt),
        totalMs: Math.round(performance.now() - started), bytes: Number(response.headers?.get('x-agent-snapshot-bytes') || response.headers?.get('content-length') || 0),
        encodedBytes: Number(response.headers?.get('x-agent-snapshot-encoded-bytes') || response.headers?.get('content-length') || 0),
        serverTiming: response.headers?.get('server-timing') || '', transport: snapshotTransportTiming(response.url) }));
    }
    if (!response.ok) throw Object.assign(new Error(body?.error?.message || body?.error || `Request failed (${response.status}).`), { status: response.status, knownResult: response.status >= 400 && response.status < 500 });
    return body;
  }
}

function missingSession(error) { return error.status === 404 || error.status === 410; }

function retryRead(signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 150);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function snapshotTransportTiming(url) {
  try {
    const entry = url && performance.getEntriesByName?.(url, 'resource').at(-1);
    if (!entry || !entry.requestStart || !entry.responseStart) return null;
    return { protocol: entry.nextHopProtocol || '',
      beforeRequestMs: Math.round(entry.requestStart - entry.fetchStart),
      dnsMs: Math.round(entry.domainLookupEnd - entry.domainLookupStart),
      connectMs: Math.round(entry.connectEnd - entry.connectStart),
      requestToHeadersMs: Math.round(entry.responseStart - entry.requestStart),
      downloadMs: Math.round(entry.responseEnd - entry.responseStart) };
  } catch { return null; }
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
  const previewTitle = title || value.preview?.title;
  const items = value.transcript?.items || (value.conversation?.turns || []).flatMap((turn) => [
    ...(turn.user ? [{ id: `${turn.id}-user`, type: 'user', text: turn.user, turnId: turn.turnId || turn.id, turnStatus: 'completed', historical: true }] : []),
    ...(turn.assistant || []).map((item, index) => ({ ...item, id: item.id || `${turn.id}-assistant-${index}`, type: 'assistant', turnId: turn.turnId || turn.id, phase: item.phase || 'final_answer', historical: true })),
  ]);
  return { ...normalizeSnapshot({ session: { id, sessionId: id.slice(8), cwd: value.cwd, model: value.model, reasoningEffort: value.reasoningEffort, tokenUsage: value.tokenUsage, access: value.access || 'full', title: previewTitle || '历史对话', ready: true, turnState: { active: Boolean(value.active) } }, items }),
    titleIsFallback: !previewTitle,
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

function checkAborted(signal) { if (signal?.aborted) throw new DOMException('Session operation was cancelled before submission.', 'AbortError'); }
