import fs from "node:fs";
import path from "node:path";

export function readAgentSessionFavorites(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeSessionIds(parsed);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return [];
    throw error;
  }
}

export function setAgentSessionFavorite(filePath, sessionId, favorited) {
  const id = normalizeSessionId(sessionId);
  if (!id) throw new TypeError("Agent Session ID 不合法");

  const favorites = new Set(readAgentSessionFavorites(filePath));
  if (favorited) favorites.add(id);
  else favorites.delete(id);

  const next = [...favorites];
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
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
