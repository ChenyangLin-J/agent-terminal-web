export function normalizeAccessMode(value) {
  return value === "full" ? "full" : "safe";
}

export function latestPersistedSessionsByCodexId(records = {}) {
  const latest = new Map();

  for (const record of Object.values(records)) {
    if (!record?.sessionId || !["safe", "full"].includes(record.access)) continue;
    const current = latest.get(record.sessionId);
    if (!current || recordTimestamp(record) >= recordTimestamp(current)) {
      latest.set(record.sessionId, record);
    }
  }

  return latest;
}

export function persistedAccessForCodexSession(records, sessionId) {
  if (!sessionId) return null;
  const record = latestPersistedSessionsByCodexId(records).get(sessionId);
  return record ? normalizeAccessMode(record.access) : null;
}

export function preferredAccessForCodexSession(settings, records, sessionId) {
  const stored = settings?.[sessionId]?.access;
  if (["safe", "full"].includes(stored)) return normalizeAccessMode(stored);
  return persistedAccessForCodexSession(records, sessionId);
}

function recordTimestamp(record) {
  const value = new Date(record?.lastActivityAt || record?.startedAt || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}
