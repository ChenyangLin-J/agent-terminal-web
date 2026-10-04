/** Product-owned file transport. The shared UI owns picker state; Agent Web owns authorization and paths. */
export async function uploadAgentWebAttachments(files, { signal } = {}) {
  const form = new FormData();
  for (const file of files || []) form.append('files', file);
  const response = await fetch('/api/uploads', { method: 'POST', body: form, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '附件上传失败。');
  return (body.files || []).map((file) => ({
    id: file.path,
    path: file.path,
    name: file.originalName || file.storedName || '附件',
    originalName: file.originalName || file.storedName || '附件',
    mimeType: file.mime || 'application/octet-stream',
    mime: file.mime || 'application/octet-stream',
    size: Number(file.size || 0),
    kind: String(file.mime || '').startsWith('image/') ? 'image' : 'file',
    previewUrl: String(file.mime || '').startsWith('image/') ? localFileUrl(file.path) : '',
  }));
}

export function localFileUrl(path) {
  return `/open/local?path=${encodeURIComponent(path)}`;
}

export function normalizeUploadedAttachment(value = {}) {
  const path = String(value.path || value.id || '');
  const mime = String(value.mime || value.mimeType || 'application/octet-stream');
  return { path, originalName: String(value.originalName || value.name || '附件'), mime, size: Number(value.size || 0) };
}
