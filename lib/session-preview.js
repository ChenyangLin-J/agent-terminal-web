import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const MAX_PROMPT_CHARS = 8_000;
const MAX_RESULT_CHARS = 24_000;

export function readSessionPreviews(file) {
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .map(([id, preview]) => [id, normalizeSessionPreview({ ...preview, sessionId: id })])
        .filter(([, preview]) => preview),
    );
  } catch {
    return {};
  }
}

export function saveSessionPreview(file, value) {
  const preview = normalizeSessionPreview(value);
  if (!preview) return null;

  const previews = readSessionPreviews(file);
  previews[preview.sessionId] = preview;
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  fsSync.writeFileSync(tempFile, `${JSON.stringify(previews, null, 2)}\n`, { mode: 0o600 });
  fsSync.renameSync(tempFile, file);
  return preview;
}

export function normalizeSessionPreview(value) {
  const sessionId = String(value?.sessionId || "").trim();
  const result = cleanPreviewText(value?.result, MAX_RESULT_CHARS);
  if (!sessionId || !result) return null;

  const completedAt = validTimestamp(value?.completedAt) || new Date().toISOString();
  return {
    sessionId,
    prompt: cleanPreviewText(value?.prompt, MAX_PROMPT_CHARS),
    result,
    completedAt,
    updatedAt: validTimestamp(value?.updatedAt) || completedAt,
  };
}

export async function extractSessionPreviewFromJsonl(file, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, Math.max(64 * 1024, Number(maxBytes) || DEFAULT_TAIL_BYTES));
    const offset = Math.max(0, stat.size - bytesToRead);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return extractSessionPreviewFromLines(text.split("\n"));
  } finally {
    await handle.close();
  }
}

export function extractSessionPreviewFromLines(lines) {
  let result = "";
  let completedAt = "";

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonLine(lines[index]);
    if (!record) continue;
    const message = responseMessage(record);

    if (!result) {
      if (message?.role !== "assistant" || message.phase !== "final_answer") continue;
      result = messageText(message);
      if (!result) continue;
      completedAt = validTimestamp(record.timestamp) || validTimestamp(record.payload?.timestamp) || "";
      continue;
    }

    if (message?.role !== "user") continue;
    return normalizeSessionPreview({
      sessionId: sessionIdFromRecord(record) || "preview",
      prompt: messageText(message),
      result,
      completedAt,
    });
  }

  if (!result) return null;
  return normalizeSessionPreview({ sessionId: "preview", result, completedAt });
}

function responseMessage(record) {
  if (record?.type !== "response_item") return null;
  const payload = record.payload;
  return payload?.type === "message" ? payload : null;
}

function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sessionIdFromRecord(record) {
  return String(record?.payload?.thread_id || record?.payload?.threadId || "").trim();
}

function cleanPreviewText(value, limit) {
  const text = String(value || "").replaceAll("\u0000", "").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function validTimestamp(value) {
  const text = String(value || "").trim();
  return text && !Number.isNaN(new Date(text).getTime()) ? new Date(text).toISOString() : "";
}

function parseJsonLine(line) {
  if (!line?.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
