import path from "node:path";

export function viewedImagePath(session, itemId) {
  const id = String(itemId || "");
  if (!id || !Array.isArray(session?.appTranscript)) return null;
  const item = session.appTranscript.find((entry) => entry.id === id);
  if (item?.type !== "tool" || item.label !== "查看图片") return null;
  const filePath = String(item.text || "").trim();
  return path.isAbsolute(filePath) ? path.normalize(filePath) : null;
}
