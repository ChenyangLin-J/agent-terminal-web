/** Product-owned operations used by the shared Platform application. */
export function normalizeAgentWebSideChatPanel(value) {
  const current = value?.id && value.status !== 'closed' ? value : { id: 'side-chat-draft', items: [] };
  return { selectedId: current.id, sideChats: [{ ...current, title: 'Side Chat', status: current.active ? 'running' : current.error ? 'error' : 'idle', createdAt: current.startedAt, transcript: current.items || [] }] };
}

export function createAgentWebProductController({ fetchImpl = globalThis.fetch, locationRef = globalThis.location } = {}) {
  async function request(url, options = {}) {
    const response = await fetchImpl(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  return Object.freeze({
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
