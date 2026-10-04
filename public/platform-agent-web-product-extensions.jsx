import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './platform-agent-web-product.css';
import { SessionComposerUtilities, SessionRealtimePanel, SideChatPanel, SubagentPanel } from '@agent-workbench/platform/ui';
import { agentWebVoiceCapture } from './platform-agent-web-voice.js';
import { agentWebNotificationTarget, enableAgentWebNotifications } from './platform-agent-web-notifications.js';
import { normalizeAgentWebSideChatPanel } from './platform-agent-web-product-controller.js';

export function createAgentWebExtensions({ product, controller, adapter }) {
  return {
    renderListHeaderActions: ({ closeList }) => <ProductSettingsMenu product={product} controller={controller} closeList={closeList} />,
    renderComposerActions: ({ draft, setDraft, disabled, session }) => <SessionComposerUtilities
      context={sessionContext(controller, session)} disabled={disabled} sessionId={session.sessionId}
      setDraft={setDraft} variant="actions" voice={agentWebVoiceCapture(session.sessionId)} />,
    renderComposerOptions: ({ draft, setDraft, disabled, session }) => <SessionComposerUtilities
      context={sessionContext(controller, session)} disabled={disabled} sessionId={session.sessionId}
      setDraft={setDraft} variant="options" voice={agentWebVoiceCapture(session.sessionId)} />,
    renderHeaderActions: ({ session }) => session.composerDisabled ? null : <SessionMoreMenu controller={controller} session={session} />,
    renderBeforeMessages: ({ session }) => session.composerDisabled ? <p className="cwu-read-only" role="status">子 Agent · 只读 · {session.status === 'running' ? '运行中 · 自动更新' : '已完成'}</p> : null,
    renderSessionMorePanel: ({ session, sourceSession }) => <SessionMorePanel controller={controller} adapter={adapter} session={session} sourceSession={sourceSession} />,
  };
}

function ProductSettingsMenu({ product, controller, closeList }) {
  const [open, setOpen] = useState(false);
  const [updates, setUpdates] = useState(null);
  const [notice, setNotice] = useState('');
  const [projects, setProjects] = useState(null);
  const [cwd, setCwd] = useState(() => localStorage.getItem('agent-web.default-cwd') || '.');
  async function chooseWorkspace() {
    setOpen(false); closeList?.();
    try { const response = await fetch('/api/projects'); const value = await response.json(); if (!response.ok) throw new Error(value.error); setProjects(value.projects || []); } catch (error) { setNotice(error.message); }
  }
  async function showUpdates() {
    setOpen(false); closeList?.();
    try {
      const response = await fetch('/api/codex-updates', { cache: 'no-store' });
      const body = await response.json();
      setUpdates(Array.isArray(body.items) ? body.items : []);
    } catch (error) { setNotice(error.message || '读取更新失败。'); }
  }
  async function logout() { try { await product.logout(); } catch (error) { setNotice(error.message); } }
  async function restart() {
    if (!globalThis.confirm?.('重启 Agent Web？正在运行的任务可能中断。')) return;
    try { await product.restart(); setNotice('已请求重启，服务恢复后请刷新页面。'); } catch (error) { setNotice(error.message); }
  }
  async function enablePwa() {
    try { await navigator.serviceWorker?.register('/sw.js'); setNotice('离线支持已启用。'); } catch (error) { setNotice(error.message || '离线支持不可用。'); }
  }
  return <>
    <details className="cwu-product-settings" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="产品设置" title="产品设置"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="m9.5 3-.5 2-2 1-2-.5L3.5 8l1.5 1.5v3L3.5 14l1 2.5 2-.5 2 1 .5 2h3l.5-2 2-1 2 .5 1-2.5-1.5-1.5v-3L18 8l-1-2.5-2 .5-2-1-.5-2z"/><circle cx="10.5" cy="11" r="3"/></svg></summary>
      <div>
        <button type="button" onClick={chooseWorkspace}>新对话工作区</button>
        <button type="button" onClick={() => { setOpen(false); closeList?.(); const session = controller.getSnapshot().session?.session; globalThis.AgentMemories?.open?.({ projects: session?.memoryProjects, mode: session?.memoryProjectMode, source: session?.memoryProjectSource,
          onProjectChange: session ? (routing) => controller.execute('raw', { type: 'set-memory-projects', ...routing }) : undefined }); }}>记忆</button>
        <button type="button" onClick={() => { setOpen(false); closeList?.(); globalThis.AgentIntegrations?.open?.(); }}>集成</button>
        <button type="button" onClick={showUpdates}>Codex 更新</button>
        <button type="button" onClick={restart}>服务管理</button>
        <button type="button" onClick={enablePwa}>离线支持</button>
        <button type="button" onClick={() => { setOpen(false); closeList?.(); void enableAgentWebNotifications(agentWebNotificationTarget()).then(() => setNotice('完成通知已开启。')).catch(error => setNotice(error.message)); }}>完成通知</button>
        <button type="button" onClick={logout}>退出登录</button>
      </div>
    </details>
    {notice ? <output className="cwu-product-notice">{notice}</output> : null}
    {projects ? <ProductDialog label="新对话工作区" onClose={() => setProjects(null)}><header><strong>新对话工作区</strong><button type="button" onClick={() => setProjects(null)}>×</button></header><label>工作目录 <select value={cwd} onChange={event => setCwd(event.target.value)}><option value=".">Workspace</option>{projects.map(project => <option value={project} key={project}>{project}</option>)}</select></label><button type="button" onClick={() => { localStorage.setItem('agent-web.default-cwd', cwd); setProjects(null); void controller.execute('create', { cwd, title: '新对话' }).catch(error => setNotice(error.message)); }}>开始新对话</button></ProductDialog> : null}
    {updates ? <ProductDialog label="Codex 更新" onClose={() => setUpdates(null)}><header><strong>Codex 更新</strong><button type="button" onClick={() => setUpdates(null)}>×</button></header>{updates.length ? updates.map((item) => <article key={item.version}><strong>Codex CLI {item.version}</strong>{item.features?.length ? <p>{item.features.join(' · ')}</p> : <p>暂无更新摘要。</p>}{item.url ? <a href={item.url} target="_blank" rel="noreferrer">查看发布说明</a> : null}</article>) : <p>暂无更新记录。</p>}</ProductDialog> : null}
  </>;
}

function SessionMoreMenu({ controller, session }) {
  const [error, setError] = useState('');
  const perform = (type) => controller.execute('raw', { type }, { sessionId: session.sessionId }).catch(error => setError(error.message));
  async function lifecycle(action) {
    if (!globalThis.confirm?.(action === 'end' ? '结束当前 Session？历史记录会保留。' : '重启当前 Session？本轮任务会中断。')) return;
    try { await controller.execute(action); if (action === 'end') await controller.execute('create', { title: '新对话' }); await controller.refreshSessions(); } catch (error) { setError(error.message); }
  }
  async function rename() {
    const title = globalThis.prompt?.('对话名称', session.title);
    if (title == null) return;
    try { await controller.execute('rename', { title }); await controller.refreshSessions(); } catch (error) { setError(error.message); }
  }
  return <details className="cwu-product-session-tools"><summary aria-label="会话更多操作">⋯</summary><div>
    <button type="button" onClick={() => { globalThis.dispatchEvent(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: session.sessionId, panel: 'side' } })); void perform('side-chat-open'); }}>Side Chat</button>
    <button type="button" onClick={() => { globalThis.dispatchEvent(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: session.sessionId, panel: 'subagents' } })); void perform('subagents-list'); }}>Subagent</button>
    <button type="button" onClick={() => globalThis.dispatchEvent(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: session.sessionId, panel: 'realtime' } }))}>实时语音</button>
    {['usage', 'tree', 'share'].map((panel) => <button key={panel} type="button" onClick={() => globalThis.dispatchEvent(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: session.sessionId, panel } }))}>{panel === 'usage' ? '账户用量' : panel === 'tree' ? '线程关系' : '分享'}</button>)}
    <button type="button" onClick={rename}>重命名</button>
    <button type="button" onClick={() => lifecycle('restart')}>重启当前 Session</button>
    <button type="button" onClick={() => lifecycle('end')}>结束当前 Session</button>
    {error ? <p role="alert">{error}</p> : null}
  </div></details>;
}

function SessionMorePanel({ controller, adapter, session, sourceSession = session }) {
  const [panel, setPanel] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const open = (event) => { if (event.detail?.sessionId === session.sessionId) { setPanel(event.detail.panel); setResult(event.detail.result || null); } };
    globalThis.addEventListener('agent-web-open-session-panel', open);
    return () => globalThis.removeEventListener('agent-web-open-session-panel', open);
  }, [session.sessionId]);
  if (!panel) return null;
  const run = async (type, payload = {}) => {
    if (type === 'realtime-audio') return adapter.execute(session.sessionId, 'raw', { type, ...payload });
    try { const value = await controller.execute('raw', { type, ...payload }, { sessionId: session.sessionId }); setError(''); setResult(value); return value; }
    catch (error) { setError(error.message); throw error; }
  };
  return <ProductDialog label="会话工具" onClose={() => setPanel('')}><header><strong>会话工具</strong><button type="button" onClick={() => setPanel('')}>×</button></header>
    <nav><button type="button" onClick={() => setPanel('side')}>Side Chat</button><button type="button" onClick={() => { setPanel('subagents'); void run('subagents-list').catch(() => {}); }}>Subagent</button><button type="button" onClick={() => setPanel('realtime')}>实时语音</button></nav>
    {error ? <p role="alert">{error}</p> : null}
    {panel === 'side' ? <SideChatPanel panel={normalizeAgentWebSideChatPanel(sourceSession.sideChat)} actions={{
      onSelect: () => run('side-chat-open'), onCreate: () => run('side-chat-open'), onSubmit: ({ prompt }) => run('side-chat-submit', { data: prompt }),
      onStop: () => run('side-chat-stop'), onDelete: () => run('side-chat-close'),
    }} /> : null}
    {panel === 'subagents' ? <SubagentPanel panel={{ agents: session.subagents || [], selected: sourceSession.subagentDetail || null }} actions={{ onOpen: (agent) => { const url = new URL(location.href); url.search = new URLSearchParams({ preview: '1', sessionId: agent.id, sourceSession: sourceSession.webSessionId || session.sessionId }); location.href = url; }, onStop: (agent) => run('subagent-stop', { threadId: agent.id }) }} /> : null}
    {['usage', 'tree'].includes(panel) ? <section><button type="button" onClick={() => void run(panel === 'tree' ? 'session-tree' : 'command', panel === 'usage' ? { data: '/usage' } : {}).catch(() => {})}>读取{panel === 'usage' ? '账户用量' : '线程关系'}</button>{result ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}</section> : null}
    {panel === 'share' ? <SessionShare session={sourceSession} /> : null}
    {panel === 'command' ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
    {panel === 'realtime' ? <SessionRealtimePanel enabled={session.status !== 'running'} initialState={sourceSession.realtime || {}} event={sourceSession.realtimeEvent} onSend={(message) => run(message.type, message)} onFallback={() => setPanel('side')} /> : null}
  </ProductDialog>;
}

function sessionContext(controller, session) {
  return {
    usage: session.tokenUsage ?? null,
    onRead: () => controller.execute('readContext', {}, { sessionId: session.sessionId }),
    onCompact: () => controller.execute('compact', {}, { sessionId: session.sessionId }),
  };
}

function ProductDialog({ label, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const focus = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); focus?.focus?.(); };
  }, []);
  return createPortal(<dialog ref={dialog} className="cwu-product-dialog" aria-label={label} onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>{children}</dialog>, document.body);
}

function SessionShare({ session }) {
  const [shares, setShares] = useState([]), [error, setError] = useState('');
  const threadId = session.threadId || '';
  useEffect(() => { fetch(`/api/session-shares?sessionId=${encodeURIComponent(threadId)}`).then(response => response.json()).then(body => setShares(body.shares || [])).catch(error => setError(error.message)); }, [threadId]);
  async function create() {
    try { const response = await fetch('/api/session-shares', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ webSessionId: session.webSessionId || session.sessionId, sessionId: threadId }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error); setShares(current => [{ ...body.share, url: body.url }, ...current]); setError(''); } catch (error) { setError(error.message); }
  }
  async function revoke(id) { await fetch(`/api/session-shares/${encodeURIComponent(id)}`, { method: 'DELETE' }); setShares(current => current.filter(item => item.id !== id)); }
  return <section><button type="button" onClick={create}>创建只读分享链接</button>{shares.map(item => <p key={item.id}>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">打开分享</a> : <span>已有分享 · {item.expiresAt}</span>} <button type="button" onClick={() => revoke(item.id)}>撤销</button></p>)}{error ? <p role="alert">{error}</p> : null}</section>;
}
