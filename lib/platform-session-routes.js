import { referenceFromSession, requireReferences } from './session-references.js';
import { createHash } from 'node:crypto';
import { isValidOperationReceiptKey, rememberSessionOperationReceipt, settleSessionOperationReceipt } from './session-operation-receipts.js';

/** Product HTTP projection consumed by the common Platform Host Kit. */
export function registerPlatformSessionRoutes(app, host) {
  app.get('/api/platform/threads/:id/process/:turnId', async (req, res) => {
    if (!host.validThread(req.params.id) || !host.validTurn(req.params.turnId)) return res.status(400).json({ error: 'Invalid historical turn.' });
    try {
      const items = await host.readProcess({ sessionId: req.params.id }, req.params.turnId);
      res.set('Cache-Control', 'private, no-store');
      res.json({ items });
    } catch { res.status(404).json({ error: 'The process for this turn is unavailable.' }); }
  });

  app.get('/api/platform/sessions', async (req, res) => {
    const query = String(req.query.q || '').trim();
    const archived = req.query.archived === '1';
    const offset = Number(req.query.cursor || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) return res.status(400).json({ error: 'Invalid history cursor.' });
    const live = host.listWebSessions();
    const byThread = new Map(live.map((session) => [session.sessionId, session]));
    const historical = query ? (await host.searchSessions(query)).map((result) => ({ ...result.session, snippet: result.snippet || result.preview || '' })) : await host.listCodexSessions({ archived: false });
    if (archived && !query) historical.push(...await host.listCodexSessions({ archived: true }));
    const favorites = host.favoriteIds();
    const all = new Map(live.filter((session) => !query || `${session.title} ${session.project || ''} ${(session.turnState?.requirements || []).map(item => item.text).join(' ')} ${(host.sessions.get(session.id)?.appTranscript || []).map(item => `${item.text || ''} ${item.output || ''}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())).map((session) => [session.sessionId || session.id, { ...session, threadId: session.sessionId, favorited: favorites.has(session.sessionId) }]));
    for (const item of historical) {
      if (!archived && item.archived) continue;
      const web = byThread.get(item.id);
      const key = item.id;
      all.set(key, { ...item, ...web, id: web?.id || `history:${item.id}`, threadId: item.id, sessionId: web?.sessionId || item.id, historical: !web, favorited: favorites.has(item.id) });
    }
    const values = [...all.values()].sort((a, b) => (Date.parse(b.lastActivityAt || b.updatedAt || b.createdAt) || 0) - (Date.parse(a.lastActivityAt || a.updatedAt || a.createdAt) || 0));
    res.json({ sessions: values.slice(offset, offset + 50).map(session => ({ ...session, reference: referenceFromSession(session) })), nextCursor: offset + 50 < values.length ? String(offset + 50) : null });
  });

  app.post('/api/platform/session-references/resolve', async (req, res) => {
    try {
      const references = requireReferences(req.body?.references);
      const resolved = await host.resolveReferences(String(req.body?.sourceThreadId || ''), references);
      res.json({ references: resolved.map(item => item.reference) });
    } catch (error) { res.status(error.status || 502).json({ error: error.message }); }
  });

  app.get('/api/platform/sessions/:id', async (req, res) => {
    let session = host.sessions.get(req.params.id);
    if (!session) session = host.restore(req.params.id);
    if (!session || session.error || session.exited) return res.status(404).json({ error: 'This Session is no longer available.' });
    res.set('Cache-Control', 'private, no-store');
    res.json(host.snapshot(session));
  });

  app.post('/api/platform/sessions', async (req, res) => {
    const payload = req.body || {};
    const key = String(payload.idempotencyKey || '');
    if (key && !isValidOperationReceiptKey(key)) return res.status(400).json({ error: 'Invalid operation ID.' });
    const cwd = host.resolvePath(String(payload.cwd || '.'));
    if (!cwd) return res.status(400).json({ error: 'Invalid cwd outside workspace root.' });
    const launch = { mode: payload.sessionId ? 'resume-id' : 'new', transport: 'app-server', access: host.access(payload.access), sessionId: String(payload.sessionId || ''), args: ['app-server'], title: host.title(String(payload.title || '')), purpose: host.purpose(payload.purpose) };
    const fingerprint = hash({ cwd, launch });
    if (key) {
      const previous = [...host.sessions.values()].find((session) => session.operationReceipts?.has(key));
      const record = previous || Object.values(host.records()).find((record) => (record.operationReceipts || []).some((receipt) => receipt.key === key));
      if (record) {
        const receipt = previous ? previous.operationReceipts.get(key) : record.operationReceipts.find((receipt) => receipt.key === key);
        if (receipt.fingerprint !== fingerprint) return res.status(409).json({ error: 'Operation ID already belongs to another request.' });
        const restored = previous || host.restore(record.id);
        if (!restored || restored.error) return res.status(202).json({ pending: true, idempotent: true });
        return res.json(host.snapshot(restored));
      }
    }
    const session = launch.sessionId && host.findReusable(launch) || host.create(cwd, launch);
    if (key) {
      rememberSessionOperationReceipt(session, key, { kind: 'create-session', fingerprint });
      settleSessionOperationReceipt(session, key, { result: { sessionId: session.id } });
      host.persist(session);
    }
    res.status(201).json(host.snapshot(session));
  });

  app.get('/api/platform/sessions/:id/actions/:action', async (req, res) => {
    const session = host.sessions.get(req.params.id);
    if (!session || session.exited) return res.status(404).json({ error: 'Session is not available.' });
    if (req.params.action === 'readContext') return res.json(await host.status(session));
    if (req.params.action === 'models') return res.json(await host.models(session, ''));
    res.status(404).json({ error: 'Unknown Session read action.' });
  });

  app.post('/api/platform/sessions/:id/actions/:action', async (req, res) => {
    const session = host.sessions.get(req.params.id);
    if (!session || session.exited) return res.status(404).json({ error: 'Session is not available.' });
    const action = req.params.action;
    const payload = req.body || {};
    const key = String(payload.idempotencyKey || '');
    const fingerprint = hash({ action, ...payload, idempotencyKey: undefined });
    if (key && !isValidOperationReceiptKey(key)) return res.status(400).json({ error: 'Invalid operation ID.' });
    const previous = key && session.operationReceipts?.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return res.status(409).json({ error: 'Operation ID already belongs to another request.' });
      if (previous.state === 'failed') return res.status(409).json({ error: previous.failure });
      return res.json({ ...(previous.result || {}), pending: previous.state === 'pending', idempotent: true });
    }
    if (key) rememberSessionOperationReceipt(session, key, { kind: action, fingerprint }, () => host.persist(session));
    try {
      let result;
      if (action === 'compact') {
        if (session.turnState.active || session.appServer.activeTurnId) throw new Error('当前任务仍在处理，完成后再压缩上下文。');
        await session.appServer.compactThread(); result = { accepted: true };
      } else if (action === 'executionProfile') {
        if (session.turnState.active || session.appServer.activeTurnId) throw new Error('当前任务仍在处理，完成后再修改执行设置。');
        const profile = payload.executionProfile || payload;
        if (profile.model) await host.models(session, `${profile.model} ${profile.reasoningEffort || ''}`.trim());
        if (profile.accessMode) session.access = host.access(profile.accessMode);
        session.appServiceTier = profile.serviceTier === 'priority' ? 'priority' : 'default';
        result = { executionProfile: { model: session.appModel, reasoningEffort: session.appReasoningEffort, accessMode: session.access, serviceTier: session.appServiceTier } };
      } else if (action === 'deleteQueuedTurn') {
        const id = String(payload.queuedTurnId || payload.id || '');
        if (!session.turnState.queuedTurns.some((turn) => turn.id === id)) throw new Error('这条消息已离开队列。');
        session.appServer.cancelQueuedTurn(id);
        session.turnState.queuedTurns = session.turnState.queuedTurns.filter((turn) => turn.id !== id);
        result = { queuedTurnId: id };
      } else throw new Error('Unknown Session mutation.');
      if (key) settleSessionOperationReceipt(session, key, { result });
      host.persist(session); host.broadcast(session);
      res.json(result);
    } catch (error) {
      if (key) settleSessionOperationReceipt(session, key, { error }, () => host.persist(session));
      res.status(409).json({ error: error.message });
    }
  });
}

function hash(payload) { return createHash('sha256').update(JSON.stringify(payload)).digest('hex'); }
