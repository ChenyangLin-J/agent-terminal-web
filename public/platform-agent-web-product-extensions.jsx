import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './platform-agent-web-product.css';
import { SessionComposerUtilities, SessionRealtimePanel, SideChatPanel, SubagentPanel } from '@agent-workbench/platform/ui';
import { agentWebVoiceCapture } from './platform-agent-web-voice.js';
import { agentWebNotificationTarget, enableAgentWebNotifications } from './platform-agent-web-notifications.js';
import { memorySourceEntriesForMessage, normalizeAgentWebSideChatPanel } from './platform-agent-web-product-controller.js';
import { agentWebSessionContext } from './platform-agent-web-adapter.js';

export function createAgentWebExtensions({ product, controller, adapter }) {
  return {
    renderListHeaderActions: ({ closeList }) => <ProductSettingsMenu product={product} controller={controller} closeList={closeList} />,
    renderComposerActions: ({ draft, setDraft, disabled, session, onRecordingChange }) => <SessionComposerUtilities
      context={agentWebSessionContext(controller, session)} disabled={disabled} draft={draft} onRecordingChange={onRecordingChange} sessionId={session.sessionId}
      setDraft={setDraft} variant="actions" voice={agentWebVoiceCapture(session.sessionId)} />,
    renderComposerOptions: ({ draft, setDraft, disabled, session, onRecordingChange }) => <SessionComposerUtilities
      context={agentWebSessionContext(controller, session)} disabled={disabled} draft={draft} onRecordingChange={onRecordingChange} sessionId={session.sessionId}
      setDraft={setDraft} variant="options" voice={agentWebVoiceCapture(session.sessionId)} />,
    renderHeaderActions: ({ session }) => session.composerDisabled ? null : <SessionMoreMenu controller={controller} session={session} />,
    renderBeforeMessages: ({ session }) => session.composerDisabled ? <p className="cwu-read-only" role="status">子 Agent · 只读 · {session.status === 'running' ? '运行中 · 自动更新' : '已完成'}</p> : null,
    getTurnDetailTabs: ({ message }) => {
      const entries = memorySourceEntriesForMessage(message, controller.getSnapshot().session);
      return [{ id: 'memory', label: '参考记忆', count: entries.length,
        renderContent: () => <MemorySources entries={entries} product={product} /> }];
    },
    renderSessionMorePanel: ({ session, sourceSession }) => <SessionMorePanel controller={controller} adapter={adapter} session={session} sourceSession={sourceSession} />,
  };
}

function MemorySources({ entries, product }) {
  if (!entries.length) return <p className="cwu-memory-empty">本轮没有可确认的记忆来源。</p>;
  return <div className="cwu-memory-source-list" aria-label="本轮读取的记忆来源">
    {entries.map((entry, index) => <button
      key={`${entry.path}:${entry.lineStart || ''}:${index}`}
      title={entry.note || entry.path}
      type="button"
      onClick={() => product.openLocalDocument(
        `${entry.path}${entry.lineStart ? `:${entry.lineStart}` : ''}`,
        { name: entry.path.split(/[\\/]/).at(-1) },
      )}
    ><svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M5 2.5h6l4 4v11H5zM11 2.5v4h4M7.5 10h5M7.5 13h5"/></svg><span>{entry.path.split(/[\\/]/).at(-1)}</span><span aria-hidden="true">›</span></button>)}
  </div>;
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
  const menu = useRef(null);
  const openPanel = (panel) => { if (menu.current) menu.current.open = false; globalThis.dispatchEvent(new CustomEvent('agent-web-open-session-panel', { detail: { sessionId: session.sessionId, panel } })); };
  async function lifecycle(action) {
    if (!globalThis.confirm?.(action === 'end' ? '结束当前 Session？历史记录会保留。' : '重启当前 Session？本轮任务会中断。')) return;
    try { await controller.execute(action); if (action === 'end') await controller.execute('create', { title: '新对话' }); await controller.refreshSessions(); } catch (error) { setError(error.message); }
  }
  async function rename() {
    const title = globalThis.prompt?.('对话名称', session.title);
    if (title == null) return;
    try { await controller.execute('rename', { title }); await controller.refreshSessions(); } catch (error) { setError(error.message); }
  }
  return <details ref={menu} className="cwu-product-session-tools"><summary aria-label="会话更多操作">⋯</summary><div>
    <button type="button" onClick={() => openPanel('side')}>关联会话</button>
    <button type="button" onClick={() => openPanel('realtime')}>实时语音</button>
    {['usage', 'share'].map((panel) => <button key={panel} type="button" onClick={() => openPanel(panel)}>{panel === 'usage' ? '账户用量' : '分享'}</button>)}
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
  const relatedPanelId = useId();
  useEffect(() => {
    const open = (event) => { if (event.detail?.sessionId === session.sessionId) { setError(''); setPanel(event.detail.panel); setResult(event.detail.result || null); } };
    globalThis.addEventListener('agent-web-open-session-panel', open);
    return () => globalThis.removeEventListener('agent-web-open-session-panel', open);
  }, [session.sessionId]);
  useEffect(() => {
    if (!['side', 'subagents'].includes(panel)) return;
    let cancelled = false;
    void controller.execute('raw', { type: panel === 'side' ? 'side-chat-open' : 'subagents-list' }, { sessionId: session.sessionId }).catch(error => { if (!cancelled) setError(error.message); });
    return () => { cancelled = true; };
  }, [controller, session.sessionId, panel]);
  if (!panel) return null;
  const run = async (type, payload = {}) => {
    if (type === 'realtime-audio') return adapter.execute(session.sessionId, 'raw', { type, ...payload });
    try { const value = await controller.execute('raw', { type, ...payload }, { sessionId: session.sessionId }); setError(''); setResult(value); return value; }
    catch (error) { setError(error.message); throw error; }
  };
  const usagePanel = panel === 'usage' || panel === 'command' && result?.kind === 'usage';
  const relatedPanel = ['side', 'subagents', 'tree'].includes(panel);
  const relatedTabs = [{ id: 'side', label: 'Side Chat' }, { id: 'subagents', label: 'Subagent' }, { id: 'tree', label: '线程关系' }];
  const title = relatedPanel ? '关联会话' : usagePanel ? '账户用量' : ({ realtime: '实时语音', share: '分享' }[panel] || '会话工具');
  const selectRelated = (id) => { setError(''); setResult(null); setPanel(id); };
  return <ProductDialog label={title} onClose={() => setPanel('')}><header><strong>{title}</strong><button type="button" aria-label="关闭会话工具" onClick={() => setPanel('')}>×</button></header>
    {relatedPanel ? <nav role="tablist" aria-label="关联会话">{relatedTabs.map((tab, index) => <button key={tab.id} id={`${relatedPanelId}-${tab.id}`} type="button" role="tab" aria-selected={panel === tab.id} aria-controls={relatedPanelId} tabIndex={panel === tab.id ? 0 : -1} onClick={() => selectRelated(tab.id)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? relatedTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : relatedTabs.length - 1)) % relatedTabs.length;
      selectRelated(relatedTabs[next].id); event.currentTarget.parentElement.children[next].focus();
    }}>{tab.label}</button>)}</nav> : null}
    {error ? <p role="alert">{error}</p> : null}
    {relatedPanel ? <div role="tabpanel" id={relatedPanelId} aria-labelledby={`${relatedPanelId}-${panel}`}>
    <div hidden={panel !== 'side'}><SideChatPanel singleChat panel={normalizeAgentWebSideChatPanel(sourceSession.sideChat)} actions={{
      onSelect: () => run('side-chat-open'), onCreate: () => run('side-chat-open'), onSubmit: ({ prompt }) => run('side-chat-submit', { data: prompt }),
      onStop: () => run('side-chat-stop'), onDelete: () => run('side-chat-close'),
    }} /></div>
    {panel === 'subagents' ? <SubagentPanel panel={{ agents: session.subagents || [], selected: sourceSession.subagentDetail || null }} actions={{ onOpen: (agent) => { const url = new URL(location.href); url.search = new URLSearchParams({ preview: '1', sessionId: agent.id, sourceSession: sourceSession.webSessionId || session.sessionId }); location.href = url; }, onStop: (agent) => run('subagent-stop', { threadId: agent.id }) }} /> : null}
    {panel === 'tree' ? <ThreadRelationsPanel controller={controller} sessionId={session.sessionId} onOpen={async node => { await controller.select(`history:${node.id}`); setPanel(''); }} /> : null}
    </div> : null}
    {usagePanel ? <AccountUsagePanel key={`${session.sessionId}:${panel}`} controller={controller} sessionId={session.sessionId} initialResult={result} /> : null}
    {panel === 'share' ? <SessionShare session={sourceSession} /> : null}
    {panel === 'command' && !usagePanel ? <pre>{JSON.stringify(result, null, 2)}</pre> : null}
    {panel === 'realtime' ? <SessionRealtimePanel inline enabled={session.status !== 'running'} initialState={sourceSession.realtime || {}} event={sourceSession.realtimeEvent} onSend={(message) => run(message.type, message)} onFallback={() => { setPanel(''); requestAnimationFrame(() => document.querySelector('.cwu-composer textarea')?.focus()); }} /> : null}
  </ProductDialog>;
}

function ThreadRelationsPanel({ controller, sessionId, onOpen }) {
  const [tree, setTree] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const generation = useRef(0);
  async function read() {
    const request = ++generation.current; setLoading(true); setError('');
    try { const value = await controller.execute('raw', { type: 'session-tree' }, { sessionId }); if (request === generation.current) setTree(value); }
    catch (error) { if (request === generation.current) setError(error.message || '会话关系读取失败。'); }
    finally { if (request === generation.current) setLoading(false); }
  }
  useEffect(() => { void read(); return () => { generation.current++; }; }, [controller, sessionId]);
  const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  const ordered = [], visited = new Set();
  function visit(node, depth = 0) { if (visited.has(node.id)) return; visited.add(node.id); ordered.push({ node, depth }); nodes.filter(child => child.parentId === node.id).forEach(child => visit(child, depth + 1)); }
  nodes.filter(node => !byId.has(node.parentId)).forEach(node => visit(node)); nodes.forEach(node => visit(node));
  return <section className="cwu-thread-relations" aria-busy={loading}>
    <div className="cwu-relations-intro"><p>查看当前会话的来源、分支和子 Agent。Side Chat 是临时侧问，不属于线程分支。</p><button type="button" disabled={loading} onClick={() => void read()}>{loading ? '读取中…' : '刷新关系'}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {!tree && loading ? <p role="status">正在读取会话关系…</p> : null}
    {tree && nodes.length <= 1 ? <p className="cwu-relations-empty">当前会话还没有分支或子 Agent。</p> : null}
    <ul>{ordered.map(({ node, depth }) => <li key={node.id} style={{ '--thread-depth': Math.min(depth, 5) }}><div><span className="cwu-relation-kind">{node.relation === 'agent' ? '子 Agent' : node.relation === 'branch' ? '分支' : '主会话'}{node.current ? ' · 当前' : ''}</span><strong>{node.name || '未命名会话'}</strong>{node.parentId && byId.get(node.parentId) ? <small>来自：{byId.get(node.parentId).name || '未命名会话'}</small> : null}</div>{!node.current ? <button type="button" aria-label={`查看对话：${node.name || '未命名会话'}`} onClick={() => Promise.resolve(onOpen(node)).catch(error => setError(error.message))}>查看对话</button> : null}</li>)}</ul>
  </section>;
}

function AccountUsagePanel({ controller, sessionId, initialResult }) {
  const [usage, setUsage] = useState(initialResult);
  const [loading, setLoading] = useState(!initialResult);
  const [error, setError] = useState('');
  const generation = useRef(0);
  async function read() {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const value = await controller.execute('raw', { type: 'command', data: '/usage' }, { sessionId });
      if (request === generation.current) setUsage(value);
    } catch (error) { if (request === generation.current) setError(error.message || '账户用量读取失败。'); }
    finally { if (request === generation.current) setLoading(false); }
  }
  useEffect(() => { if (!initialResult) void read(); return () => { generation.current++; }; }, [controller, sessionId]);
  const windows = Array.isArray(usage?.rateLimits) ? usage.rateLimits : [];
  const account = usage?.account;
  return <section className="cwu-account-usage" aria-busy={loading}>
    <div className="cwu-account-summary"><div><strong>{account?.planType || 'Codex 账户'}</strong>{account?.email ? <small>{account.email}</small> : null}</div><button type="button" disabled={loading} onClick={() => void read()}>{loading ? '读取中…' : '刷新用量'}</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {!usage && loading ? <p role="status">正在读取账户用量…</p> : null}
    {usage && !windows.length ? <p className="cwu-account-empty">当前未返回账户额度信息。</p> : null}
    <div className="cwu-account-windows">{windows.map((window, index) => {
      const minutes = Number(window.windowDurationMins);
      const duration = minutes === 10080 ? '每周额度' : minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} 小时额度` : minutes > 0 ? `${minutes} 分钟额度` : window.kind === 'primary' ? '主要额度' : '其他额度';
      const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : null;
      const reset = Number(window.resetsAt) > 0 ? new Date(Number(window.resetsAt) * 1000).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return <article key={`${window.limitId}:${window.kind}:${index}`}><div><strong>{duration}</strong><span>{used === null ? '用量未知' : `剩余 ${100 - used}%`}</span></div>{window.limitName || window.limitId ? <small>{window.limitName || window.limitId}</small> : null}{used !== null ? <progress aria-label={`${duration}已使用`} max="100" value={used} /> : null}<footer><span>{used === null ? '等待用量信息' : `已用 ${used}%`}</span>{reset ? <span>{reset} 重置</span> : null}</footer></article>;
    })}</div>
    {usage?.credits?.unlimited ? <p className="cwu-account-extra">额外额度：不限量</p> : usage?.credits?.balance != null ? <p className="cwu-account-extra">额外额度余额：{String(usage.credits.balance)}</p> : null}
  </section>;
}

function ProductDialog({ label, onClose, children }) {
  const dialog = useRef(null);
  useEffect(() => {
    const focus = document.activeElement?.closest('details:not([open])')?.querySelector('summary') || document.activeElement;
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
