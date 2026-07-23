import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";

const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const MAX_DETAIL_CHARS = 4_000;

export async function extractSessionProcessFromJsonl(
  file,
  turnId,
  { maxBytes = DEFAULT_TAIL_BYTES } = {},
) {
  const id = String(turnId || "").trim();
  if (!id) return [];
  const { lines, truncated } = await readTailLines(file, maxBytes);
  const recent = await extractProcessItems(lines, id);
  if (recent.sawTurn || !truncated) return recent.items;
  return (await extractProcessItems(readAllLines(file), id)).items;
}

async function extractProcessItems(lines, id) {
  const items = [];
  const calls = new Map();
  let sawTurn = false;

  for await (const line of lines) {
    if (!line.includes(id)) continue;
    const record = parseLine(line);
    const payload = record?.type === "response_item" ? record.payload : null;
    if (!payload || responseTurnId(payload) !== id) continue;
    sawTurn = true;

    if (payload.type === "message" && payload.role === "assistant" && payload.phase === "commentary") {
      const text = messageText(payload);
      if (text) {
        items.push({
          id: historyItemId(payload.id || `commentary-${items.length + 1}`),
          type: "assistant",
          label: "Codex",
          text,
          phase: "commentary",
          status: "completed",
          turnId: id,
          turnStartedAt: timestampMs(record.timestamp),
          historical: true,
        });
      }
      continue;
    }

    if (["function_call", "custom_tool_call"].includes(payload.type)) {
      const item = processItemFromCall(payload, id, record.timestamp);
      if (!item) continue;
      calls.set(String(payload.call_id || payload.id || ""), item);
      items.push(item);
      continue;
    }

    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const item = calls.get(String(payload.call_id || ""));
      if (!item) continue;
      item.status = payload.success === false ? "failed" : "completed";
      if (!["file", "image"].includes(item.processKind)) {
        item.output = cleanText(toolOutputText(payload.output), MAX_TEXT_CHARS);
      }
    }
  }

  return {
    items: items.map(({ processKind: _processKind, ...item }) => item),
    sawTurn,
  };
}

function processItemFromCall(payload, turnId, timestamp) {
  const name = String(payload.name || "工具");
  const callId = String(payload.call_id || payload.id || "");
  if (!callId) return null;
  const rawArguments = payload.arguments ?? payload.input ?? "";
  const args = parseArguments(rawArguments);
  const base = {
    id: historyItemId(callId),
    status: "completed",
    turnId,
    turnStartedAt: timestampMs(timestamp),
    historical: true,
  };

  if (name === "exec_command") {
    return {
      ...base,
      type: "command",
      label: "命令",
      text: cleanText(args.cmd || name, MAX_TEXT_CHARS),
      detail: args.workdir ? `目录：${cleanText(args.workdir, MAX_DETAIL_CHARS)}` : "",
      processKind: "command",
    };
  }

  if (name === "view_image") {
    return {
      ...base,
      type: "tool",
      label: "查看图片",
      text: cleanText(args.path || "图片", MAX_DETAIL_CHARS),
      processKind: "image",
    };
  }

  if (name === "apply_patch") {
    return {
      ...base,
      type: "file",
      label: "文件修改",
      text: patchSummary(rawArguments),
      processKind: "file",
    };
  }

  return {
    ...base,
    type: "tool",
    label: "工具",
    text: cleanText(name, 200),
    detail: cleanText(toolArgumentsText(rawArguments), MAX_DETAIL_CHARS),
    processKind: "tool",
  };
}

async function readTailLines(file, maxBytes) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const bytes = Math.min(stat.size, Math.max(64 * 1024, Number(maxBytes) || DEFAULT_TAIL_BYTES));
    const offset = Math.max(0, stat.size - bytes);
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
    }
    return {
      lines: text.split("\n"),
      truncated: offset > 0,
    };
  } finally {
    await handle.close();
  }
}

async function* readAllLines(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) yield line;
  } finally {
    lines.close();
    input.destroy();
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function responseTurnId(payload) {
  return String(
    payload.internal_chat_message_metadata_passthrough?.turn_id ||
      payload.turn_id ||
      payload.turnId ||
      "",
  );
}

function parseArguments(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolArgumentsText(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function toolOutputText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => String(item?.text || item?.type || "")).filter(Boolean).join("\n");
  return "";
}

function patchSummary(value) {
  const text = String(value || "");
  const files = [...text.matchAll(/\*\*\* (?:Add|Update|Delete) File: ([^\r\n]+)/g)].map((match) => match[1].trim());
  return files.length ? files.map((file) => `修改 · ${file}`).join("\n") : "修改文件";
}

function messageText(payload) {
  return cleanText(
    (Array.isArray(payload.content) ? payload.content : [])
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n"),
    MAX_TEXT_CHARS,
  );
}

function historyItemId(value) {
  return `history-${String(value || "").slice(0, 300)}`;
}

function timestampMs(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value, limit) {
  const text = String(value || "").replaceAll("\u0000", "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
