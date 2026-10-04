import path from 'node:path';
import { pathToFileURL } from 'node:url';

const contracts = await import(process.env.AGENT_PLATFORM_CANDIDATE
  ? pathToFileURL(path.resolve(process.env.AGENT_PLATFORM_CANDIDATE, 'src/session-references.js')).href
  : '@agent-workbench/platform/session-references');
export const { createSessionReferenceEnvelopeInput, normalizeSessionReferences, parseSessionReferenceEnvelopes, sessionReferenceKey } = contracts;
export const AGENT_WEB_REFERENCE_HOST = 'agent-web';

export function requireReferences(values) {
  const source = values == null ? [] : values;
  const references = normalizeSessionReferences(source);
  if (!Array.isArray(source) || source.length > 8 || references.length !== source.length) {
    throw Object.assign(new Error('Session 引用格式无效、重复或超过数量限制。'), { status: 400 });
  }
  return references;
}

export function referenceFromSession(session) {
  const threadId = session?.threadId || session?.sessionId;
  return normalizeSessionReferences([{ hostId: AGENT_WEB_REFERENCE_HOST, threadId, label: session?.title || '未命名 Session', updatedAt: session?.updatedAt || session?.lastActivityAt, archived: Boolean(session?.archived) }])[0] || null;
}

export async function resolveAgentWebReferences(sourceThreadId, values, readTarget) {
  const requested = requireReferences(values);
  const resolved = await Promise.all(requested.map(async reference => {
    if (reference.hostId !== AGENT_WEB_REFERENCE_HOST || reference.threadId === sourceThreadId) return null;
    const target = await readTarget(reference.threadId);
    if (!target || target.archived) return null;
    const canonical = referenceFromSession(target);
    if (!canonical || canonical.threadId !== reference.threadId) return null;
    const context = (target.messages || []).filter(message => ['user', 'assistant'].includes(message.role))
      .slice(-6).map(message => `${message.role}: ${parseSessionReferenceEnvelopes(message.text || message.content || '').text.slice(-1000)}`).join('\n');
    return { reference: canonical, context };
  }));
  return resolved.filter(Boolean);
}
