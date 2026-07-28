import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { commandDisplayText } from "./command-display.js";
import { parseOrchestratedToolCalls } from "./tool-orchestration.js";

const DEFAULT_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;
const MAX_DETAIL_CHARS = 4_000;
const PROCESS_INDEX_VERSION = 1;
const processIndexBuilds = new Map();

export async function extractSessionProcessFromJsonl(
  file,
  turnId,
  { maxBytes = DEFAULT_TAIL_BYTES, indexFile = "" } = {},
) {
  const id = String(turnId || "").trim();
  if (!id) return [];
  let indexed = null;
  if (indexFile) {
    indexed = await readSessionProcessIndex(indexFile);
    if (indexed?.turns?.[id] && (await sessionProcessIndexIsCurrent(file, indexed))) {
      const indexedItems = await extractIndexedProcessItems(file, indexed, id);
      if (indexedItems) return indexedItems;
    }
  }
  const { lines, truncated } = await readTailLines(file, maxBytes);
  const recent = await extractProcessItems(lines, id);
  if (recent.sawTurn || !truncated) return recent.items;
  if (indexFile) {
    const indexedItems = await extractIndexedProcessItems(file, indexed, id);
    if (indexedItems) return indexedItems;
    const rebuilt = await warmSessionProcessIndex(file, indexFile);
    const rebuiltItems = await extractIndexedProcessItems(file, rebuilt, id);
    if (rebuiltItems) return rebuiltItems;
  }
  return (await extractProcessItems(readAllLines(file), id)).items;
}

async function sessionProcessIndexIsCurrent(file, index) {
  try {
    const stat = await fs.stat(file);
    return index?.sourceSize === stat.size && Number(index?.sourceMtimeMs) === stat.mtimeMs;
  } catch {
    return false;
  }
}

export async function warmSessionProcessIndex(file, indexFile) {
  if (!indexFile) return null;
  const key = `${file}\u0000${indexFile}`;
  if (processIndexBuilds.has(key)) return processIndexBuilds.get(key);
  const build = buildSessionProcessIndex(file, indexFile).finally(() => {
    if (processIndexBuilds.get(key) === build) processIndexBuilds.delete(key);
  });
  processIndexBuilds.set(key, build);
  return build;
}

async function buildSessionProcessIndex(file, indexFile) {
  const stat = await fs.stat(file);
  const previous = await readSessionProcessIndex(indexFile);
  const canAppend =
    previous?.version === PROCESS_INDEX_VERSION &&
    Number.isSafeInteger(previous.sourceSize) &&
    previous.sourceSize >= 0 &&
    previous.sourceSize <= stat.size;
  if (
    canAppend &&
    previous.sourceSize === stat.size &&
    Number(previous.sourceMtimeMs) === stat.mtimeMs
  ) {
    return previous;
  }

  const startOffset = canAppend && previous.sourceSize < stat.size ? previous.sourceSize : 0;
  const turns = startOffset > 0 ? normalizeProcessIndexTurns(previous.turns) : {};
  await scanProcessIndexRange(file, {
    startOffset,
    endOffset: stat.size,
    turns,
  });
  const index = {
    version: PROCESS_INDEX_VERSION,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    turns,
  };
  await writeSessionProcessIndex(indexFile, index);
  return index;
}

async function scanProcessIndexRange(file, { startOffset, endOffset, turns }) {
  if (endOffset <= startOffset) return;
  const input = createReadStream(file, {
    encoding: "utf8",
    start: startOffset,
    end: endOffset - 1,
  });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let offset = startOffset;
  try {
    for await (const line of lines) {
      const lineStart = offset;
      const lineEnd = Math.min(endOffset, lineStart + Buffer.byteLength(line, "utf8") + 1);
      offset = lineEnd;
      if (!line.includes('"turn_id"') && !line.includes('"turnId"')) continue;
      const record = parseLine(line);
      const payload = record?.type === "response_item" ? record.payload : null;
      const turnId = payload ? responseTurnId(payload) : "";
      if (!turnId) continue;
      const current = turns[turnId];
      turns[turnId] = current
        ? [Math.min(current[0], lineStart), Math.max(current[1], lineEnd)]
        : [lineStart, lineEnd];
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

async function extractIndexedProcessItems(file, index, turnId) {
  const range = normalizeProcessIndexRange(index?.turns?.[turnId]);
  if (!range) return null;
  const stat = await fs.stat(file);
  if (range[0] >= stat.size || range[1] > stat.size) return null;
  const extracted = await extractProcessItems(readRangeLines(file, range), turnId);
  return extracted.items;
}

async function readSessionProcessIndex(indexFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(indexFile, "utf8"));
    if (parsed?.version !== PROCESS_INDEX_VERSION || !parsed.turns || typeof parsed.turns !== "object") {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    return null;
  }
}

async function writeSessionProcessIndex(indexFile, index) {
  await fs.mkdir(path.dirname(indexFile), { recursive: true });
  const temporaryFile = `${indexFile}.${process.pid}.tmp`;
  await fs.writeFile(temporaryFile, `${JSON.stringify(index)}\n`, { mode: 0o600 });
  await fs.rename(temporaryFile, indexFile);
}

function normalizeProcessIndexTurns(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([turnId, range]) => [String(turnId), normalizeProcessIndexRange(range)])
      .filter(([, range]) => range),
  );
}

function normalizeProcessIndexRange(value) {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const start = Number(value[0]);
  const end = Number(value[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) return null;
  return [start, end];
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
      const call = processItemsFromCall(payload, id, record.timestamp);
      if (!call) continue;
      calls.set(String(payload.call_id || payload.id || ""), call);
      items.push(...call.items);
      continue;
    }

    if (["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const call = calls.get(String(payload.call_id || ""));
      if (!call) continue;
      applyProcessOutput(call, payload);
    }
  }

  return {
    items: items.map(({ processKind: _processKind, ...item }) => item),
    sawTurn,
  };
}

function processItemsFromCall(payload, turnId, timestamp) {
  const name = String(payload.name || "工具");
  const callId = String(payload.call_id || payload.id || "");
  if (!callId) return null;
  const rawArguments = payload.arguments ?? payload.input ?? "";
  const orchestratedCalls = name === "exec" ? parseOrchestratedToolCalls(rawArguments) : [];
  const descriptors = orchestratedCalls.length
    ? orchestratedCalls
    : [{ name, args: parseArguments(rawArguments), rawArguments }];
  const items = descriptors.map((descriptor, index) =>
    processItemFromTool(descriptor, {
      id: historyItemId(orchestratedCalls.length ? `${callId}-${index + 1}` : callId),
      status: "completed",
      turnId,
      turnStartedAt: timestampMs(timestamp),
      historical: true,
    }),
  );
  return { items, orchestrated: orchestratedCalls.length > 0 };
}

function processItemFromTool({ name, args = {}, rawArguments = "" }, base) {
  if (name === "exec_command") {
    return {
      ...base,
      type: "command",
      label: "命令",
      text: cleanText(commandDisplayText(args.cmd || args.command || name), MAX_TEXT_CHARS),
      detail: args.workdir ? `目录：${cleanText(args.workdir, MAX_DETAIL_CHARS)}` : "",
      processKind: "command",
    };
  }

  if (name === "write_stdin") {
    return {
      ...base,
      type: "command",
      label: "命令",
      text: "继续运行命令",
      detail: args.session_id ? `Session：${cleanText(args.session_id, 200)}` : "",
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

  if (name === "web__run") {
    return {
      ...base,
      type: "tool",
      label: "网页",
      text: webToolText(args),
      detail: cleanText(toolArgumentsText(args), MAX_DETAIL_CHARS),
      processKind: "tool",
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

function applyProcessOutput(call, payload) {
  const status = payload.success === false ? "failed" : "completed";
  for (const item of call.items) item.status = status;

  const mappedOutputs = call.orchestrated
    ? orchestratedToolOutputs(payload.output, call.items.length)
    : [toolOutputText(payload.output)];
  if (!mappedOutputs) return;

  call.items.forEach((item, index) => {
    if (["file", "image"].includes(item.processKind)) return;
    const output = cleanText(mappedOutputs[index] || "", MAX_TEXT_CHARS);
    if (output) item.output = output;
  });
}

function orchestratedToolOutputs(value, itemCount) {
  const blocks = toolOutputBlocks(value);
  if (blocks.length === itemCount + 1 && /^Script (?:completed|running)/.test(blocks[0])) {
    return blocks.slice(1);
  }
  if (blocks.length === itemCount) return blocks;
  if (itemCount === 1) return [blocks.join("\n")];
  return null;
}

function webToolText(args) {
  const labels = {
    search_query: "搜索网页",
    image_query: "搜索图片",
    open: "打开网页",
    click: "打开链接",
    find: "查找网页内容",
    screenshot: "查看页面",
  };
  const actions = Object.keys(labels).filter((key) => Array.isArray(args?.[key]) && args[key].length);
  return actions.length ? actions.map((key) => labels[key]).join(" · ") : "网页操作";
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

async function* readRangeLines(file, range) {
  const input = createReadStream(file, {
    encoding: "utf8",
    start: range[0],
    end: range[1] - 1,
  });
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
  if (Array.isArray(value)) return toolOutputBlocks(value).filter(Boolean).join("\n");
  return "";
}

function toolOutputBlocks(value) {
  if (!Array.isArray(value)) return typeof value === "string" ? [value] : [];
  return value.map((item) => String(item?.text || ""));
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
