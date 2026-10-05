import { readJsonFileSync, writeJsonFileAtomicSync } from "./json-state-file.js";

export function readAgentSessionFavorites(filePath) {
  const parsed = readJsonFileSync(filePath, {
    label: "Agent Session favorites",
    missingValue: () => [],
    validate: Array.isArray,
  });
  return normalizeSessionIds(parsed);
}

export function setAgentSessionFavorite(filePath, sessionId, favorited) {
  const id = normalizeSessionId(sessionId);
  if (!id) throw new TypeError("Agent Session ID 不合法");

  const favorites = new Set(readAgentSessionFavorites(filePath));
  if (favorited) favorites.add(id);
  else favorites.delete(id);

  const next = [...favorites];
  writeJsonFileAtomicSync(filePath, next, { label: "Agent Session favorites" });
  return next;
}

function normalizeSessionIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(normalizeSessionId).filter(Boolean))];
}

function normalizeSessionId(value) {
  const id = String(value || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id) ? id : "";
}
