import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS = 2 * 60 * 60 * 1000;

const HOST_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXTRACTION_INTENT_PATTERN = /(?:提取|转写|逐字稿|存档|归档|保存)(?:一下|下来|这个|该)?/i;
const NEGATED_EXTRACTION_PATTERN = /(?:不要|不用|无需|不需要|别|无需帮我)(?:再)?(?:提取|转写|做逐字稿|生成逐字稿|存档|归档|保存)/gi;
const ANALYSIS_ONLY_PATTERN = /(?:只(?:要|做|需)?|仅(?:做|需)?|帮我|请)?\s*(?:分析|研究|摘要|总结|评价|点评|解读|判断|说说看法|谈谈看法)/i;
const SHARE_COPY_PATTERN = /(?:复制.{0,12}(?:打开|到)|打开.{0,8}(?:抖音|小红书)|查看完整笔记|去[^\s，。！？]{0,8}看看|分享.{0,8}(?:视频|笔记|作品))/i;
const URL_CANDIDATE_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'，。！？【】（）]+|(?<![a-z0-9.-])(?:(?:[a-z0-9-]+\.)*douyin\.com|(?:[a-z0-9-]+\.)*xiaohongshu\.com|(?:[a-z0-9-]+\.)*xhslink\.(?:cn|com))(?![a-z0-9.-])(?:\/[^\s<>"'，。！？【】（）]*)?/gi;

export function mediaExtractionKind(text, skillNames = []) {
  const skills = Array.isArray(skillNames) ? skillNames : [];
  for (const skillName of skills) {
    const kind = skillNameKind(skillName);
    if (kind) return kind;
  }

  const source = String(text || "");
  const explicitSkill = source.match(/\$(douyin-transcript|xiaohongshu-transcript)\b/i)?.[1];
  if (explicitSkill) return explicitSkill.toLowerCase().startsWith("douyin") ? "douyin" : "xiaohongshu";

  const links = mediaLinks(source);
  if (!links.length) return "";

  const withoutNegatedExtraction = source.replace(NEGATED_EXTRACTION_PATTERN, "");
  const hasExtractionIntent = EXTRACTION_INTENT_PATTERN.test(withoutNegatedExtraction);
  if (!hasExtractionIntent && ANALYSIS_ONLY_PATTERN.test(source)) return "";

  const withoutLinks = removeMediaLinks(source).replace(/[\s，。！？、；：:,.!?;“”‘’"'【】\[\]()（）<>《》~-]+/g, "");
  const looksStandalone = withoutLinks.length === 0;
  const looksShared = SHARE_COPY_PATTERN.test(source)
    || links.some(({ kind }) => source.includes(kind === "douyin" ? "抖音" : "小红书"));
  if (!looksStandalone && !looksShared && !hasExtractionIntent) return "";

  return links[0].kind;
}

export class MediaSessionAutoArchiveStore {
  constructor(filePath, { idleMs = MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS } = {}) {
    const resolvedPath = String(filePath || "").trim();
    if (!resolvedPath) throw new TypeError("Auto-archive file path is required");
    if (!Number.isSafeInteger(idleMs) || idleMs < 0) throw new TypeError("Auto-archive idleMs is invalid");

    this.filePath = path.resolve(resolvedPath);
    this.idleMs = idleMs;
    this.records = loadRecords(this.filePath);
  }

  recordPrompt({ hostId, sessionId, text, skillNames = [], isFirstPrompt = false, now = Date.now() } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const timestamp = validateTimestamp(now);
    const key = recordKey(identity.hostId, identity.sessionId);
    const current = this.records.get(key);

    if (current) {
      return this.recordFollowUp({ ...identity, now: timestamp });
    }

    if (!isFirstPrompt) return null;
    const kind = mediaExtractionKind(text, skillNames);
    if (!kind) return null;

    const record = {
      ...identity,
      kind,
      lastUserMessageAt: timestamp,
      completedAt: null,
      lastCompletedTurnId: "",
    };
    this.records.set(key, record);
    this.#write();
    return cloneRecord(record);
  }

  recordFollowUp({ hostId, sessionId, now = Date.now() } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const timestamp = validateTimestamp(now);
    const record = this.records.get(recordKey(identity.hostId, identity.sessionId));
    if (!record) return null;
    record.lastUserMessageAt = timestamp;
    record.hasFollowUp = true;
    record.completedAt = null;
    this.#write();
    return cloneRecord(record);
  }

  recordCompletion({ hostId, sessionId, turnId, successful = true, now = Date.now() } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const timestamp = validateTimestamp(now);
    const record = this.records.get(recordKey(identity.hostId, identity.sessionId));
    if (!record) return null;
    if (record.hasFollowUp) return cloneRecord(record);

    const normalizedTurnId = normalizeTurnId(turnId);
    if (!normalizedTurnId) throw new TypeError("Completed turn ID is invalid");
    if (!successful) {
      const changed = record.completedAt !== null || record.lastCompletedTurnId !== normalizedTurnId;
      record.completedAt = null;
      record.lastCompletedTurnId = normalizedTurnId;
      if (changed) {
        this.#write();
      }
      return cloneRecord(record);
    }
    if (normalizedTurnId && normalizedTurnId === record.lastCompletedTurnId) {
      return cloneRecord(record);
    }

    record.completedAt = timestamp;
    record.lastCompletedTurnId = normalizedTurnId;
    this.#write();
    return cloneRecord(record);
  }

  cancel({ hostId, sessionId } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const record = this.records.get(recordKey(identity.hostId, identity.sessionId));
    if (!record) return null;
    if (record.completedAt !== null) {
      record.completedAt = null;
      this.#write();
    }
    return cloneRecord(record);
  }

  get({ hostId, sessionId } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const record = this.records.get(recordKey(identity.hostId, identity.sessionId));
    return record ? cloneRecord(record) : null;
  }

  dueRecords(now = Date.now()) {
    const timestamp = validateTimestamp(now);
    return [...this.records.values()]
      .filter((record) => !record.hasFollowUp && record.completedAt !== null
        && record.completedAt >= record.lastUserMessageAt
        && timestamp >= record.completedAt + this.idleMs)
      .map((record) => ({
        ...cloneRecord(record),
        dueAt: record.completedAt + this.idleMs,
      }))
      .sort((left, right) => left.dueAt - right.dueAt
        || left.hostId.localeCompare(right.hostId)
        || left.sessionId.localeCompare(right.sessionId));
  }

  forget({ hostId, sessionId } = {}) {
    const identity = validateIdentity(hostId, sessionId);
    const removed = this.records.delete(recordKey(identity.hostId, identity.sessionId));
    if (removed) this.#write();
    return removed;
  }

  #write() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const records = [...this.records.values()]
      .map(cloneRecord)
      .sort((left, right) => left.hostId.localeCompare(right.hostId)
        || left.sessionId.localeCompare(right.sessionId));
    try {
      fs.writeFileSync(
        temporaryPath,
        `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      try {
        fs.unlinkSync(temporaryPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
}

function mediaLinks(text) {
  const links = [];
  for (const match of String(text || "").matchAll(URL_CANDIDATE_PATTERN)) {
    const raw = match[0];
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      const hostname = new URL(candidate).hostname.toLowerCase().replace(/\.$/, "");
      const kind = hostnameKind(hostname);
      if (kind) links.push({ kind, raw });
    } catch {
      // Ignore malformed URL-like text.
    }
  }
  return links;
}

function removeMediaLinks(text) {
  return String(text || "").replace(URL_CANDIDATE_PATTERN, (raw) => {
    const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    try {
      return hostnameKind(new URL(candidate).hostname.toLowerCase().replace(/\.$/, "")) ? "" : raw;
    } catch {
      return raw;
    }
  });
}

function hostnameKind(hostname) {
  if (hostname === "douyin.com" || hostname.endsWith(".douyin.com")) return "douyin";
  if (hostname === "xhslink.cn" || hostname.endsWith(".xhslink.cn")
    || hostname === "xhslink.com" || hostname.endsWith(".xhslink.com")
    || hostname === "xiaohongshu.com" || hostname.endsWith(".xiaohongshu.com")) {
    return "xiaohongshu";
  }
  return "";
}

function skillNameKind(value) {
  const name = String(value || "").trim().toLowerCase().replace(/^\$/, "");
  if (name === "douyin-transcript" || name.endsWith(":douyin-transcript")) return "douyin";
  if (name === "xiaohongshu-transcript" || name.endsWith(":xiaohongshu-transcript")) return "xiaohongshu";
  return "";
}

function loadRecords(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return new Map();
    throw error;
  }

  const result = new Map();
  for (const value of Array.isArray(parsed?.records) ? parsed.records : []) {
    const record = normalizeStoredRecord(value);
    if (record) result.set(recordKey(record.hostId, record.sessionId), record);
  }
  return result;
}

function normalizeStoredRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let identity;
  try {
    identity = validateIdentity(value.hostId, value.sessionId);
  } catch {
    return null;
  }
  if (value.kind !== "douyin" && value.kind !== "xiaohongshu") return null;
  if (!isTimestamp(value.lastUserMessageAt)) return null;
  if (value.completedAt !== null && !isTimestamp(value.completedAt)) return null;
  return {
    ...identity,
    kind: value.kind,
    lastUserMessageAt: value.lastUserMessageAt,
    completedAt: value.completedAt,
    lastCompletedTurnId: normalizeTurnId(value.lastCompletedTurnId),
    ...(value.hasFollowUp === true ? { hasFollowUp: true } : {}),
  };
}

function validateIdentity(hostId, sessionId) {
  const normalizedHostId = String(hostId || "").trim();
  const normalizedSessionId = String(sessionId || "").trim().toLowerCase();
  if (!HOST_ID_PATTERN.test(normalizedHostId)) throw new TypeError("Agent host ID is invalid");
  if (!SESSION_ID_PATTERN.test(normalizedSessionId)) throw new TypeError("Agent Session ID is invalid");
  return { hostId: normalizedHostId, sessionId: normalizedSessionId };
}

function validateTimestamp(value) {
  if (!isTimestamp(value)) throw new TypeError("Auto-archive timestamp is invalid");
  return value;
}

function isTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeTurnId(value) {
  return String(value || "").trim().slice(0, 200);
}

function recordKey(hostId, sessionId) {
  return `${hostId}\u0000${sessionId}`;
}

function cloneRecord(record) {
  return { ...record };
}
