import path from "node:path";

export function viewedImagePath(session, itemId) {
  const id = String(itemId || "");
  if (!id) return null;
  const item = transcriptImageItem(session, id) || historicalImageItem(session, id);
  if (item?.type !== "tool" || item.label !== "查看图片") return null;
  const filePath = String(item.text || "").trim();
  return path.isAbsolute(filePath) ? path.normalize(filePath) : null;
}

function transcriptImageItem(session, id) {
  return Array.isArray(session?.appTranscript)
    ? session.appTranscript.find((entry) => entry.id === id)
    : null;
}

function historicalImageItem(session, id) {
  if (!(session?.historyProcessCache instanceof Map)) return null;
  for (const items of session.historyProcessCache.values()) {
    const item = Array.isArray(items) ? items.find((entry) => entry.id === id) : null;
    if (item) return item;
  }
  return null;
}
