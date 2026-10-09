import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createSessionHostController } from "@agent-workbench/platform/session-host";
import { SessionApplication } from "@agent-workbench/platform/ui";
import "@agent-workbench/platform/styles.css";
import "katex/dist/katex.min.css";
import { createAgentWebSessionAdapter } from "./platform-agent-web-adapter.js";
import { localFileUrl, normalizeUploadedAttachment, uploadAgentWebAttachments } from "./platform-agent-web-resources.js";
import { createAgentWebProductController } from "./platform-agent-web-product-controller.js";
import { createAgentWebExtensions } from "./platform-agent-web-product-extensions.jsx";
import { agentWebNotificationTarget } from './platform-agent-web-notifications.js';
import { watchAgentWebCatalog } from './platform-agent-web-catalog.js';

const mount = document.querySelector("#platform-session-application");

if (!mount) throw new Error("Missing #platform-session-application mount point.");

const adapter = createAgentWebSessionAdapter({ sourceSession: new URLSearchParams(location.search).get('sourceSession') || '', title: new URLSearchParams(location.search).get('title') || '', notificationTarget: agentWebNotificationTarget(), lazyMetadata: true });
const product = createAgentWebProductController();
const params = new URLSearchParams(location.search);
const initialSessionId = adapter.resolveSessionId(params.get('attach') || params.get('draftId') || (params.get('sessionId') ? `history:${params.get('sessionId')}` : ''));
const controller = createSessionHostController({
  adapter,
  initialSessionId,
  independentStartup: true,
  submissionFeedback: true,
  selectedSnapshotCache: true,
  capabilities: {
    attachments: true,
    queue: true,
    approvals: true,
    sideChat: true,
    subagents: true,
    realtime: true,
    voiceInput: true,
    compact: true,
  },
});

const execute = (action, payload) => controller.execute(action, payload);
let selectionMeasurement = null;
const selectMeasuredSession = (session) => {
  selectionMeasurement = { id: String(session.id || session.sessionId), started: performance.now(), framePending: false };
  return controller.select(selectionMeasurement.id);
};
controller.subscribe(() => {
  const measurement = selectionMeasurement;
  const state = controller.getSnapshot();
  if (!measurement || measurement.framePending || state.selectedId !== measurement.id || !state.session
    || (!state.session.messages?.length && state.session.status === 'connecting')) return;
  measurement.framePending = true;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (selectionMeasurement !== measurement || controller.getSnapshot().selectedId !== measurement.id) return;
    console.info('AgentWebTiming', JSON.stringify({ phase: 'selection-visible',
      totalMs: Math.round(performance.now() - measurement.started), cached: Boolean(state.selectedSnapshotCached),
      messages: state.session.messages?.length || 0 }));
    selectionMeasurement = null;
  }));
});
const stopCatalogWatch = watchAgentWebCatalog({ controller, adapter });
if (params.get('new') === '1' && !params.get('draftId')) void controller.execute('create', { cwd: params.get('cwd') || '.', title: params.get('title') || '新对话', access: params.get('access') === 'safe' ? 'safe' : 'full' }).catch(() => {});
const extensions = createAgentWebExtensions({ product, controller, adapter });
extensions.renderListFilters = () => {
  const state = controller.getSnapshot();
  if (state.listError) return <div className="cwu-product-notice" role="alert">{state.listError}<button type="button" onClick={() => void controller.refreshSessions().catch(() => {})}>重试</button></div>;
  return state.listLoading && !state.sessions.length ? <p className="cwu-product-notice" role="status">正在读取最近对话…</p> : null;
};
const detail = (state, documentPreview) => state.session ? {
  session: state.session,
  documentPreview,
  compactComposer: true,
  composerPresentation: 'split-send',
  technicalDetailsPresentation: 'tabbed',
  labels: { composerPlaceholder: state.session.readOnly ? '子 Agent 预览为只读' : '输入问题……' },
  extensions,
  features: {
    attachments: 'visible', steer: true, queuedTurns: true,
    messageEdit: !state.session.readOnly, messageFork: !state.session.readOnly, sessionStatus: false, technicalDetails: true,
  },
  actions: {
    onSubmit: ({ prompt, mode, attachments, references }) => execute(mode === 'queue' ? 'queue' : 'send', { text: prompt, references, attachments: attachments.map(normalizeUploadedAttachment) }),
    onSearchSessionReferences: ({ query }) => adapter.searchSessionReferences(state.selectedId, query),
    onResolveSessionReferences: ({ references }) => adapter.resolveSessionReferences(state.session.threadId || '', references),
    onOpenSessionReference: (reference) => controller.select(adapter.openSessionReference(reference)),
    onInterrupt: ({ turnId } = {}) => execute('stop', { expectedTurnId: turnId || state.session.activeTurnId }),
    onResume: ({ turnId } = {}) => execute('resume', { expectedTurnId: turnId || state.session.activeTurnId }),
    onLoadEarlier: () => controller.loadHistory(),
    onLoadTechnicalDetails: (turnId) => adapter.execute(state.selectedId, 'loadTechnicalDetails', { turnId }),
    onRespondToRequest: ({ token, decision, answers }) => execute(decision === 'decline' ? 'decline' : 'respond', { requestId: token, expectedTurnId: state.session.activeTurnId, decision, answers }),
    onEditMessage: ({ prompt, turnId, messageId, attachments, references }) => execute('editFork', { text: prompt, references, turnId, itemId: messageId, attachments: (attachments || []).map(normalizeUploadedAttachment) }),
    onForkMessage: async ({ turnId, messageId }) => {
      const result = await execute('fork', { turnId, itemId: messageId });
      await controller.refreshSessions();
      if (result.threadId) await controller.select(`history:${result.threadId}`);
    },
    onFinalResultVisible: ({ turnId }) => controller.markResultRead(turnId),
    onDeleteQueuedTurn: (queuedTurnId) => execute('deleteQueuedTurn', { queuedTurnId }),
    onExecutionProfileChange: (profile) => execute('executionProfile', profile),
    onLoadExecutionOptions: async () => {
      const id = state.selectedId;
      const metadata = await adapter.loadExecutionOptions(id, { cwd: state.session.cwd || state.session.session?.cwd });
      if (controller.getSnapshot().selectedId !== id) return;
      controller.updateSession(current => ({ ...current, models: metadata.models, accessModes: metadata.accessModes,
        executionProfile: { ...metadata.executionProfile, ...current.executionProfile,
          model: current.executionProfile?.model || metadata.executionProfile?.model,
          reasoningEffort: current.executionProfile?.reasoningEffort || metadata.executionProfile?.reasoningEffort } }));
    },
    onCompact: () => execute('compact'),
    onUploadAttachments: uploadAgentWebAttachments,
    onResolveMedia: ({ path, resourceId }) => localFileUrl(path || resourceId),
    onOpenLink: (href, file) => openAgentWebLink(href, file, state.session.cwd),
    onOpenAttachment: (attachment) => product.openAttachment(attachment),
    onOpenArtifact: (artifact) => product.openArtifact(artifact),
    onCloseDocument: product.closeDocument,
    documentResourceUrl: product.documentResourceUrl,
    onError: (error) => console.warn('Agent Web Session action failed', error),
  },
} : null;

function AgentWebApplication() {
  const documentPreview = useSyncExternalStore(
    product.subscribeDocumentPreview,
    product.getDocumentPreview,
    product.getDocumentPreview,
  );
  return <SessionApplication
    controller={controller}
    detail={(state) => detail(state, documentPreview)}
    extensions={extensions}
    browser={(state) => ({ showCreateTargetSelect: false, createTargets: [{ id: "session", label: "对话" }], groupMode: "time", groupOptions: [{ id: "time", label: "最近" }], loading: Boolean(state.listLoading), loadingMore: Boolean(state.listLoadingMore), hasMore: Boolean(state.nextCursor), paginationMode: 'incremental' })}
    actions={{
      onSelect: selectMeasuredSession,
      onCreate: () => controller.execute('create', { cwd: localStorage.getItem('agent-web.default-cwd') || '.', title: '新对话' }),
      onFavorite: (session, favorited) => controller.execute('favorite', { favorited }, { sessionId: session.id }).then(() => controller.refreshSessions()),
      onArchive: (session, archived) => controller.execute('archive', { archived }, { sessionId: session.id }).then(() => controller.refreshSessions()),
      onLoadMore: () => controller.refreshSessions({ cursor: controller.getSnapshot().nextCursor }).catch(() => {}),
    }}
    labels={{ productName: "Agent Web", createAriaLabel: "新建对话", countSuffix: "个对话" }}
  />;
}

createRoot(mount).render(<AgentWebApplication />);

function openAgentWebLink(href, file, sessionCwd) {
  const value = String(href || '').trim();
  if (!value) return;
  if (/^(?:https?:|mailto:|tel:|codex:)/i.test(value) || value.startsWith('//')) {
    window.open(value, '_blank', 'noopener,noreferrer');
    return;
  }
  void product.openLocalDocument(value, { basePath: file?.path || sessionCwd || '' });
}

controller.subscribe(() => {
  const { selectedId, session } = controller.getSnapshot();
  if (!selectedId || !session) return;
  const url = new URL(location.href);
  for (const key of ['new', 'preview', 'attach', 'sessionId', 'draftId']) url.searchParams.delete(key);
  if (session.released) { url.searchParams.set('attach', selectedId); url.searchParams.set('sessionId', session.threadId); url.searchParams.set('preview', '1'); }
  else if (session.webSessionId) url.searchParams.set('attach', session.webSessionId);
  else if (selectedId.startsWith('history:')) { url.searchParams.set('sessionId', selectedId.slice(8)); url.searchParams.set('preview', '1'); }
  else if (selectedId.startsWith('draft:')) { url.searchParams.set('new', '1'); url.searchParams.set('preview', '1'); url.searchParams.set('draftId', selectedId); }
  else url.searchParams.set('attach', selectedId);
  history.replaceState(null, '', url);
});

window.addEventListener("pagehide", () => { stopCatalogWatch(); controller.dispose(); }, { once: true });
