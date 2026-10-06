/** Product-owned operations used by the shared Platform application. */
import { platformFileDescriptorUrl, platformFileResourceUrl } from './platform-agent-web-resources.js';

export function normalizeAgentWebSideChatPanel(value) {
  const current = value?.id && value.status !== 'closed' ? value : { id: 'side-chat-draft', items: [] };
  return { selectedId: current.id, sideChats: [{ ...current, title: 'Side Chat', status: current.active ? 'running' : current.error ? 'error' : 'idle', createdAt: current.startedAt, transcript: current.items || [] }] };
}

export function memorySourceEntriesForMessage(message, snapshot) {
  if (message?.role !== 'assistant') return [];
  const original = [...(snapshot?.messages || []), ...(snapshot?.items || [])].find((item) => item.id === message.id);
  if (!original || original.phase !== 'final_answer') return [];
  return Array.isArray(original.memoryCitation?.entries)
    ? original.memoryCitation.entries.filter((entry) => entry?.path)
    : [];
}

export function createAgentWebProductController({ fetchImpl = globalThis.fetch, locationRef = globalThis.location } = {}) {
  const previewListeners = new Set();
  let documentPreview = null;
  let previewRequest = null;
  let previewSequence = 0;

  const publishPreview = (value) => {
    documentPreview = value;
    for (const listener of previewListeners) listener();
  };

  async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  async function openLocalDocument(href, context = {}) {
    const value = String(href || '').trim();
    if (!value) return;
    previewRequest?.abort();
    const request = new AbortController();
    const sequence = ++previewSequence;
    previewRequest = request;
    const basePath = context?.path || context?.basePath || '';
    publishPreview({
      name: context?.name || localName(value),
      path: context?.documentPath || basePath || value,
      format: 'text',
      mimeType: context?.mimeType || 'application/octet-stream',
      size: Number(context?.size || 0),
      loading: true,
    });
    try {
      const response = await fetchImpl(platformFileDescriptorUrl(value, basePath), { signal: request.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `文件读取失败 (${response.status})`);
      if (sequence !== previewSequence || previewRequest !== request) return;
      publishPreview({ ...body, loading: false });
    } catch (error) {
      if (error?.name === 'AbortError' || sequence !== previewSequence || previewRequest !== request) return;
      const message = error?.message || '文件预览失败。';
      const retryHref = encodeURI(value).replaceAll('(', '%28').replaceAll(')', '%29');
      publishPreview((documentPreview && {
        ...documentPreview,
        format: 'markdown',
        mimeType: 'text/markdown',
        loading: false,
        content: `## 无法预览\n\n${message}\n\n[重试](${retryHref})`,
        rawText: `## 无法预览\n\n${message}\n\n[重试](${retryHref})`,
        rawAvailable: true,
      }) || null);
    } finally {
      if (previewRequest === request) previewRequest = null;
    }
  }

  function openImageDocument(value = {}) {
    const src = String(value.previewUrl || value.src || '');
    if (!src) return openLocalDocument(value.path || value.id, value);
    previewRequest?.abort();
    previewRequest = null;
    previewSequence += 1;
    publishPreview({
      name: value.name || value.originalName || localName(value.path || value.id) || '图片',
      path: value.path || '',
      format: 'image',
      mimeType: value.mimeType || value.mime || 'image/*',
      size: Number(value.size || 0),
      src,
      downloadUrl: src,
      sourceLabel: value.sourceLabel || (value.resource ? 'Agent 产物' : '本地文件'),
    });
  }

  function closeDocument() {
    previewRequest?.abort();
    previewRequest = null;
    previewSequence += 1;
    publishPreview(null);
  }

  return Object.freeze({
    subscribeDocumentPreview(listener) {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    getDocumentPreview: () => documentPreview,
    closeDocument,
    openLocalDocument,
    openAttachment(value = {}) {
      if ((value.kind === 'image' || String(value.mimeType || value.mime || '').startsWith('image/')) && value.previewUrl) return openImageDocument(value);
      return openLocalDocument(value.path || value.id, value);
    },
    openArtifact(value = {}) {
      if ((value.kind === 'image' || String(value.mimeType || value.mime || '').startsWith('image/')) && value.previewUrl) return openImageDocument({ ...value, sourceLabel: 'Agent 产物', resource: value.resource || { kind: 'session-artifact' } });
      return openLocalDocument(value.path || value.href || value.id, { ...value, sourceLabel: 'Agent 产物' });
    },
    documentResourceUrl({ file, href }) {
      return platformFileResourceUrl(href, file?.path || '');
    },
    async logout() {
      const result = await request('/api/logout', { method: 'POST' });
      if (result.logoutUrl && locationRef) locationRef.href = result.logoutUrl;
      return result;
    },
    async restart() {
      return request('https://home.chenyanglin.com/api/system/agent/restart', { method: 'POST', credentials: 'include' });
    },
    archive(threadId, archived) {
      return request(`/api/codex-sessions/${encodeURIComponent(threadId)}/archive`, { method: 'PUT', body: JSON.stringify({ archived }) });
    },
    favorite(threadId, favorited) {
      return request(`/api/codex-sessions/${encodeURIComponent(threadId)}/favorite`, { method: 'PUT', body: JSON.stringify({ favorited }) });
    },

  });
}

function localName(value) {
  const source = String(value || '').split('#', 1)[0].replace(/:\d+(?::\d+)?$/, '');
  return source.split(/[\\/]/).filter(Boolean).at(-1) || '文件';
}
