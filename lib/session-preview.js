import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { isAttachmentPromptText } from "./attachment-prompt.js";

const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const DEFAULT_CONVERSATION_TAIL_BYTES = 16 * 1024 * 1024;
const SESSION_METADATA_HEAD_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 8_000;
const MAX_RESULT_CHARS = 24_000;
const derivedReads = new Map();
const DERIVED_CACHE_ENTRIES = 32;
const DERIVED_CACHE_BYTES = 32 * 1024 * 1024;
let derivedBytes = 0;

function fileVersion(stat) { return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }

// Derived memory only: every hit checks file identity/version; paging never reparses
// an unchanged file. Pending reads share work, failures and racing writes aren't kept.
async function readDerived(file, kind, maxBytes, load) {
  const key = `${typeof file === 'string' ? path.resolve(file) : file.href}\u0000${kind}\u0000${maxBytes}`;
  const version = fileVersion(await fs.stat(file, { bigint: true }));
  const previous = derivedReads.get(key);
  if (previous?.version === version) {
    derivedReads.delete(key); derivedReads.set(key, previous);
    return previous.promise;
  }
  if (previous) { derivedBytes -= previous.bytes; derivedReads.delete(key); }
  const entry = { version, bytes: 0, promise: null };
  const discard = () => { if (derivedReads.get(key) === entry) { derivedReads.delete(key); derivedBytes -= entry.bytes; } };
  entry.promise = (async () => {
    try {
      const value = await load();
      if (fileVersion(await fs.stat(file, { bigint: true })) !== version) { discard(); return value; }
      const bytes = Buffer.byteLength(JSON.stringify(value));
      if (bytes > DERIVED_CACHE_BYTES) { discard(); return value; }
      if (derivedReads.get(key) === entry) {
        entry.bytes = bytes; derivedBytes += bytes;
        while (derivedBytes > DERIVED_CACHE_BYTES) {
          const oldest = derivedReads.keys().next().value;
          derivedBytes -= derivedReads.get(oldest).bytes; derivedReads.delete(oldest);
        }
      }
      return value;
    } catch (error) { discard(); throw error; }
  })();
  derivedReads.set(key, entry);
  while (derivedReads.size > DERIVED_CACHE_ENTRIES) {
    const oldest = derivedReads.keys().next().value;
    derivedBytes -= derivedReads.get(oldest).bytes; derivedReads.delete(oldest);
  }
  return entry.promise;
}

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

export function agentMessageDisplayPhase(item) {
  const hasQuestions = Array.isArray(item?.questions) && item.questions.length > 0;
  if (item?.phase === "final_answer" && (item?.delivery === "async" || hasQuestions)) {
    return hasQuestions ? "async_question" : "async_message";
  }
  return String(item?.phase || "");
}

export async function extractSessionPreviewFromJsonl(file, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  return structuredClone(await readDerived(file, 'preview', maxBytes, async () => extractSessionPreviewFromLines(await readJsonlTailLines(file, maxBytes))));
}

export async function extractSessionTokenUsageFromJsonl(file, { maxBytes = DEFAULT_TAIL_BYTES } = {}) {
  return structuredClone(await readDerived(file, 'usage', maxBytes, () => readTokenUsage(file, maxBytes)));
}

async function readTokenUsage(file, maxBytes) {
  const lines = await readJsonlTailLines(file, maxBytes);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonLine(lines[index]);
    const payload = record?.type === "event_msg" ? record.payload : null;
    if (payload?.type !== "token_count" || !payload.info) continue;
    return {
      total: normalizeTokenUsageBreakdown(payload.info.total_token_usage || payload.info.total),
      last: normalizeTokenUsageBreakdown(payload.info.last_token_usage || payload.info.last),
      modelContextWindow: Number(payload.info.model_context_window || payload.info.modelContextWindow || 0),
    };
  }
  return null;
}

export async function extractSessionConversationFromJsonl(
  file,
  { maxBytes = DEFAULT_CONVERSATION_TAIL_BYTES, limit = 10, offset = 0 } = {},
) {
  const turns = await readDerived(file, 'conversation', maxBytes, () => readConversationTurns(file, maxBytes));
  const requestedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const requestedOffset = Math.max(0, Math.floor(Number(offset) || 0));
  const end = Math.max(0, turns.length - requestedOffset);
  const selected = structuredClone(turns.slice(Math.max(0, end - requestedLimit), end));
  return {
    turns: selected,
    hasEarlier: end > selected.length,
    nextCursor: end > selected.length ? String(requestedOffset + selected.length) : null,
  };
}

async function readConversationTurns(file, maxBytes) {
  const [lines, headMetadata] = await Promise.all([
    readJsonlTailLines(file, maxBytes),
    readSubagentSessionMetadataFromHead(file),
  ]);
  const turns = [];
  let current = null;
  const subagentMetadata = subagentSessionMetadata(lines) || headMetadata;
  const hasUserMessageEvent = lines.some((line) => {
    const record = parseJsonLine(line);
    return record?.type === "event_msg" && record.payload?.type === "user_message";
  });

  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    const payload = record.payload || {};
    if (record.type === "event_msg" && payload.type === "user_message") {
      const text = cleanPreviewText(payload.message, MAX_PROMPT_CHARS);
      if (!text) continue;
      current = {
        id: `disk-turn-${turns.length + 1}`,
        user: text,
        assistant: [],
        startedAt: validTimestamp(record.timestamp),
      };
      turns.push(current);
      continue;
    }

    const message = responseMessage(record);
    if (!hasUserMessageEvent && !subagentMetadata && message?.role === "user") {
      const text = cleanPreviewText(responseUserMessageText(message), MAX_PROMPT_CHARS);
      if (!text) continue;
      current = diskConversationTurn({
        id: `disk-response-user-${turns.length + 1}`,
        prompt: text,
        startedAt: validTimestamp(record.timestamp),
      }, turns.length);
      current.turnId = responseTurnId(message);
      turns.push(current);
      continue;
    }

    const delegatedTask = !hasUserMessageEvent && subagentMetadata ? delegatedTaskContext(record) : null;
    if (delegatedTask) {
      current = diskConversationTurn(delegatedTask, turns.length);
      turns.push(current);
      continue;
    }

    if (!current && !hasUserMessageEvent && subagentMetadata && message?.role === "assistant") {
      const spawnMetadata = subagentMetadata.source?.subagent?.thread_spawn || {};
      const fallbackName = String(
        subagentMetadata.agent_path ||
          spawnMetadata.agent_path ||
          subagentMetadata.agent_nickname ||
          spawnMetadata.agent_nickname ||
          "Subagent",
      ).trim();
      current = diskConversationTurn({ prompt: `Delegated task: ${fallbackName}` }, turns.length);
      turns.push(current);
    }
    if (!current || message?.role !== "assistant" || !["commentary", "final_answer"].includes(message.phase)) continue;
    const turnId = responseTurnId(message);
    if (turnId) {
      if (current.id.startsWith("disk-response-user-")) current.turnId = turnId;
      else current.id = turnId;
    }
    const text = cleanPreviewText(messageText(message), MAX_RESULT_CHARS);
    if (!text) continue;
    current.assistant.push({
      text,
      phase: message.phase,
      completedAt: validTimestamp(record.timestamp) || validTimestamp(record.payload?.timestamp),
    });
  }

  return turns;
}

export async function readAppServerSessionConversation(client, sessionId, { limit = 10, cursor = null } = {}) {
  const requestedLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const page = await client.listThreadTurns({
    threadId: sessionId,
    limit: requestedLimit,
    ...(cursor ? { cursor } : {}),
    sortDirection: "desc",
    itemsView: "full",
  });
  return appServerConversationFromTurnPage(page);
}

export function appServerConversationFromTurnPage(page) {
  const turns = (Array.isArray(page?.data) ? page.data : [])
    .map((turn) => {
      const user = [];
      const assistant = [];
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        if (item?.type === "userMessage") {
          const text = appServerUserMessageText(item.content);
          if (text) user.push(text);
          continue;
        }
        if (
          item?.type !== "agentMessage" ||
          !["commentary", "final_answer"].includes(String(item.phase || ""))
        ) {
          continue;
        }
        const text = cleanPreviewText(item.text, MAX_RESULT_CHARS);
        if (!text) continue;
        assistant.push({
          text,
          phase: agentMessageDisplayPhase(item),
          ...(Array.isArray(item.questions) && item.questions.length ? { questions: item.questions } : {}),
          completedAt: appServerTimestamp(item.completedAt || turn.completedAt),
        });
      }
      return {
        id: String(turn?.id || ""),
        user: cleanPreviewText(user.join("\n\n"), MAX_PROMPT_CHARS),
        assistant,
        startedAt: appServerTimestamp(turn?.startedAt),
        status: String(turn?.status || ""),
      };
    })
    .filter((turn) => turn.id && (turn.user || turn.assistant.length))
    .sort((left, right) => {
      const leftTime = new Date(left.startedAt || 0).getTime();
      const rightTime = new Date(right.startedAt || 0).getTime();
      return leftTime - rightTime;
    });
  return { turns, hasEarlier: Boolean(page?.nextCursor), nextCursor: page?.nextCursor || null };
}

async function readJsonlTailLines(file, maxBytes) {
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
    return text.split("\n");
  } finally {
    await handle.close();
  }
}

async function readSubagentSessionMetadataFromHead(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const bytesToRead = Math.min(stat.size, SESSION_METADATA_HEAD_BYTES);
    if (!bytesToRead) return null;
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return subagentSessionMetadata(buffer.subarray(0, bytesRead).toString("utf8").split("\n"));
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
    const prompt = responseUserMessageText(message);
    if (!prompt) continue;
    return normalizeSessionPreview({
      sessionId: sessionIdFromRecord(record) || "preview",
      prompt,
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

function responseTurnId(message) {
  return String(
    message?.internal_chat_message_metadata_passthrough?.turn_id ||
      message?.turn_id ||
      message?.turnId ||
      "",
  ).trim();
}

function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function responseUserMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const kinds = message?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  if (!Array.isArray(kinds)) return messageText(message);
  return content
    .filter((part, index) => String(kinds[index] || "").startsWith("user."))
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function sessionIdFromRecord(record) {
  return String(record?.payload?.thread_id || record?.payload?.threadId || "").trim();
}

function subagentSessionMetadata(lines) {
  for (const line of lines) {
    const record = parseJsonLine(line);
    if (!record) continue;
    if (record.type === "session_meta") {
      if (record.payload?.thread_source === "subagent" || record.payload?.source?.subagent) return record.payload;
    }
  }
  return null;
}

function delegatedTaskContext(record) {
  if (record?.type !== "response_item" || record.payload?.type !== "agent_message") return null;
  const text = (Array.isArray(record.payload?.content) ? record.payload.content : [])
    .filter((part) => part?.type === "input_text")
    .map((part) => String(part.text || ""))
    .join("\n")
    .trim();
  const match = text.match(/^Message Type:\s*NEW_TASK\s*\nTask name:\s*([^\n]+)\s*\nSender:[^\n]*\nPayload:\s*([\s\S]*)$/m);
  if (!match) return null;

  const taskName = match[1].trim();
  const taskBody = match[2].trim();
  if (!taskName) return null;
  return {
    id: responseTurnId(record.payload),
    prompt: taskBody ? `Delegated task: ${taskName}\n\n${taskBody}` : `Delegated task: ${taskName}`,
    startedAt: validTimestamp(record.timestamp),
  };
}

function diskConversationTurn(task, turnIndex) {
  return {
    id: task.id || `disk-turn-${turnIndex + 1}`,
    user: task.prompt,
    assistant: [],
    startedAt: task.startedAt || "",
  };
}

function normalizeTokenUsageBreakdown(value) {
  return {
    inputTokens: Number(value?.input_tokens || value?.inputTokens || 0),
    cachedInputTokens: Number(value?.cached_input_tokens || value?.cachedInputTokens || 0),
    outputTokens: Number(value?.output_tokens || value?.outputTokens || 0),
    reasoningOutputTokens: Number(value?.reasoning_output_tokens || value?.reasoningOutputTokens || 0),
    totalTokens: Number(value?.total_tokens || value?.totalTokens || 0),
  };
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

function appServerTimestamp(value) {
  if (Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  return validTimestamp(value);
}

function appServerUserMessageText(content) {
  return (Array.isArray(content) ? content : [])
    .flatMap((entry) => {
      if (typeof entry === "string") return [entry];
      if (entry?.type === "text" && entry.text) return isAttachmentPromptText(entry.text) ? [] : [entry.text];
      if (entry?.type === "image" && entry.url) return [`图片：${entry.url}`];
      if (["localImage", "localAudio", "mention"].includes(entry?.type) && entry.path) {
        return [`附件：${entry.path}`];
      }
      if (entry?.type === "skill") return [`Skill：${entry.name || entry.path || ""}`];
      return [];
    })
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join("\n");
}

function parseJsonLine(line) {
  if (!line?.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
