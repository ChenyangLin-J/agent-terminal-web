import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

const HOST_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TURN_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,160}$/;
const MAX_ASSISTANT_MESSAGE_CHARS = 24_000;

export function resolveRemoteNotificationHost({
  authorization,
  hosts = [],
  tokens,
  tokensFile,
} = {}) {
  const candidate = bearerToken(authorization);
  if (!candidate) return null;
  const configuredTokens =
    tokens instanceof Map ? tokens : readRemoteNotificationTokens(tokensFile);

  for (const host of hosts) {
    if (host?.type !== "ssh" || !HOST_ID_PATTERN.test(String(host.id || ""))) continue;
    const expected = configuredTokens.get(host.id);
    if (expected && secureTokenEqual(candidate, expected)) return host;
  }
  return null;
}

export function normalizeRemoteTurnCompletion(value) {
  const event = value?.event && typeof value.event === "object" ? value.event : value;
  if (!event || event.type !== "agent-turn-complete") return null;

  const threadId = String(event["thread-id"] || "").trim();
  const turnId = String(event["turn-id"] || "").trim();
  if (!SESSION_ID_PATTERN.test(threadId) || !TURN_ID_PATTERN.test(turnId)) return null;

  const completedAt = validTimestamp(event["completed-at"]) || new Date().toISOString();
  return {
    threadId,
    turnId,
    completedAt,
    lastAssistantMessage: cleanText(event["last-assistant-message"], MAX_ASSISTANT_MESSAGE_CHARS),
  };
}

export function readRemoteNotificationTokens(file) {
  if (!file) return new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries =
      parsed?.hosts && typeof parsed.hosts === "object" && !Array.isArray(parsed.hosts)
        ? Object.entries(parsed.hosts)
        : Object.entries(parsed || {});
    return new Map(
      entries
        .map(([hostId, value]) => [
          String(hostId || "").trim(),
          cleanToken(typeof value === "string" ? value : value?.token),
        ])
        .filter(([hostId, token]) => HOST_ID_PATTERN.test(hostId) && token),
    );
  } catch {
    return new Map();
  }
}

function bearerToken(value) {
  const match = /^Bearer ([^\s]{32,256})$/.exec(String(value || "").trim());
  return match ? cleanToken(match[1]) : "";
}

function cleanToken(value) {
  const token = String(value || "").trim();
  return token.length >= 32 && token.length <= 256 && !/\s/.test(token) ? token : "";
}

function secureTokenEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function validTimestamp(value) {
  const timestamp = String(value || "").trim();
  return timestamp && Number.isFinite(Date.parse(timestamp)) ? new Date(timestamp).toISOString() : "";
}

function cleanText(value, limit) {
  return String(value || "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, limit);
}
