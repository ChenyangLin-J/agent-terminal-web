import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { memorySystemPaths } from "../../memory-system/lib/paths.js";
import { pendingKnowledgeContext } from "./pending-knowledge.js";

const ASSESSMENTS = new Set(["actionable", "no_candidates"]);
const SKIP_REASONS = new Set(["already_covered", "pending_covered", "transient", "unsupported", "not_personal"]);
const KNOWLEDGE_TYPES = new Set(["personal_memory", "project_rule", "skill"]);
const MAX_TITLE_CHARS = 500;
const MAX_RATIONALE_CHARS = 1_500;
const MAX_QUOTE_CHARS = 1_500;
const MAX_SKIPPED = 24;

export function sessionMemoryContextFingerprint(existingEntries, reviewDecisions) {
  const confirmed = (existingEntries || []).filter((entry) => entry.status === "confirmed").map((entry) => ({
    id: entry.id, scope: entry.scope, project: entry.project, aliases: entry.aliases,
    category: entry.category, text: entry.text, sensitive: entry.sensitive,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const pending = pendingKnowledgeContext(reviewDecisions).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify({ confirmed, pending })).digest("hex");
}

/**
 * Verifies the extraction review against the actual user-authored source.
 * The returned value is deliberately only the compact model review, so callers
 * cannot accidentally use this validation step as a transcript serializer.
 */
export function validateSessionMemoryReview(output, { conversation, existingEntries = [], reviewDecisions = [] } = {}) {
  const candidateCounts = candidateArrays(output);
  const review = output?.review;
  if (!review || typeof review !== "object" || Array.isArray(review)) throw invalidReview("缺少 review。");
  const assessment = String(review.assessment || "").trim();
  if (!ASSESSMENTS.has(assessment)) throw invalidReview("review.assessment 无效。");
  const rationale = cleanText(review.rationale, MAX_RATIONALE_CHARS);
  if (!rationale) throw invalidReview("review.rationale 不能为空。");
  if (!Array.isArray(review.skipped)) throw invalidReview("review.skipped 必须是数组。");

  const totalCandidates = candidateCounts.proposals + candidateCounts.projectRules + candidateCounts.skills;
  if ((assessment === "no_candidates") !== (totalCandidates === 0)) {
    throw invalidReview("review.assessment 与候选数量不一致。");
  }

  const confirmedIds = new Set(
    (Array.isArray(existingEntries) ? existingEntries : [])
      .filter((entry) => entry?.status === "confirmed")
      .map((entry) => String(entry.id || "").trim())
      .filter(Boolean),
  );
  const pendingIds = new Set(
    (Array.isArray(reviewDecisions) ? reviewDecisions : [])
      .filter((change) => change?.status === "pending" && KNOWLEDGE_TYPES.has(change?.targetType))
      .map((change) => String(change.id || "").trim())
      .filter(Boolean),
  );
  const userEvidence = userMessages(conversation);
  for (const proposal of output.proposals) {
    if (proposal?.scope !== "global" || !["create", "update", "retire"].includes(proposal?.action)) {
      throw invalidReview("proposal 必须是可执行的 global 个人记忆变更。");
    }
    const targetId = cleanText(proposal.targetId, 160);
    if (proposal.action === "create" ? Boolean(targetId) : !confirmedIds.has(targetId)) {
      throw invalidReview("proposal.targetId 必须匹配操作和已确认的个人记忆。");
    }
    if (proposal.action !== "retire" && !cleanText(proposal.text, 20_000)) {
      throw invalidReview("proposal.text 不能为空。");
    }
    const mergePendingId = cleanText(proposal.mergePendingId, 160);
    if (mergePendingId) {
      const expectedAction = proposal.action === "retire" ? "delete" : proposal.action;
      const pending = reviewDecisions.find((change) => change?.id === mergePendingId);
      if (pending?.status !== "pending" || pending.targetType !== "personal_memory" || pending.action !== expectedAction || (expectedAction !== "create" && pending.entryId !== targetId)) {
        throw invalidReview("proposal.mergePendingId 必须匹配待审批个人记忆的操作和目标。");
      }
    }
    const quote = cleanText(proposal?.evidenceQuote, MAX_QUOTE_CHARS);
    if (!quote || !userEvidence.some((message) => normalize(message).includes(normalize(quote)))) {
      throw invalidReview("proposal.evidenceQuote 未出现在用户消息中。");
    }
  }
  const skipped = review.skipped.map((item) => validateSkipped(item, { confirmedIds, pendingIds, userEvidence }));
  if (assessment === "no_candidates") {
    const freshUsers = userMessages({ fresh: conversation?.fresh });
    if (!skipped.some((item) => freshUsers.some((message) => normalize(message).includes(normalize(item.evidenceQuote))))) {
      throw invalidReview("no_candidates 必须说明至少一条本轮用户内容为何未保存。");
    }
  }

  return { assessment, rationale, skipped };
}

/**
 * Appends a private, bounded audit record. This is diagnostic metadata, not a
 * second copy of the prompt or conversation.
 */
export async function recordSessionMemoryExtraction({
  thread,
  conversation,
  afterTimestamp,
  prompt,
  output,
  personalResults = [],
  knowledgeResults = [],
} = {}, options = {}) {
  const counts = candidateArrays(output);
  const review = compactReview(output?.review);
  const paths = memorySystemPaths(options);
  const record = {
    at: new Date().toISOString(),
    threadId: cleanText(thread?.id, 160),
    title: cleanText(thread?.title, MAX_TITLE_CHARS),
    watermark: {
      after: cleanText(afterTimestamp, 80),
      through: cleanText(conversation?.lastEventAt, 80),
    },
    prompt: {
      sha256: createHash("sha256").update(String(prompt || "")).digest("hex"),
      chars: String(prompt || "").length,
    },
    messages: messageCounts(conversation),
    modelReview: review,
    emitted: counts,
    personalResults: compactResults(personalResults, ["action", "status", "id"]),
    knowledgeResults: compactResults(knowledgeResults, ["targetType", "status", "id"]),
  };
  await appendJSONL(path.join(paths.runtimeRoot, "session-extractions.jsonl"), record);
  return record;
}

function candidateArrays(output) {
  if (!output || typeof output !== "object") throw invalidReview("提取输出必须是对象。");
  const result = {};
  for (const key of ["proposals", "projectRules", "skills"]) {
    if (!Array.isArray(output[key])) throw invalidReview(`提取输出缺少 ${key} 数组。`);
    result[key] = output[key].length;
  }
  return result;
}

function validateSkipped(value, context) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidReview("review.skipped 项无效。");
  const reason = String(value.reason || "").trim();
  if (!SKIP_REASONS.has(reason)) throw invalidReview("review.skipped.reason 无效。");
  const evidenceQuote = cleanText(value.evidenceQuote, MAX_QUOTE_CHARS);
  const rationale = cleanText(value.rationale, MAX_RATIONALE_CHARS);
  const matchedId = cleanText(value.matchedId, 160);
  if (!evidenceQuote || !rationale) throw invalidReview("review.skipped 必须有 evidenceQuote 和 rationale。");
  if (!context.userEvidence.some((message) => normalize(message).includes(normalize(evidenceQuote)))) {
    throw invalidReview("review.skipped.evidenceQuote 未出现在用户消息中。");
  }
  if (reason === "already_covered" && (!matchedId || !context.confirmedIds.has(matchedId))) {
    throw invalidReview("already_covered 必须引用已确认的 memory id。");
  }
  if (reason === "pending_covered" && (!matchedId || !context.pendingIds.has(matchedId))) {
    throw invalidReview("pending_covered 必须引用仍待审批的知识变更 id。");
  }
  if (!["already_covered", "pending_covered"].includes(reason) && matchedId) {
    throw invalidReview("此 skipped 原因不能带 matchedId。");
  }
  return { reason, evidenceQuote, matchedId, rationale };
}

function compactReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review)) return { source: "model_explanation", assessment: "invalid" };
  return {
    source: "model_explanation",
    assessment: cleanText(review.assessment, 40) || "invalid",
    rationale: cleanText(review.rationale, MAX_RATIONALE_CHARS),
    skipped: (Array.isArray(review.skipped) ? review.skipped : []).slice(0, MAX_SKIPPED).map((item) => ({
      reason: cleanText(item?.reason, 80),
      evidenceQuote: cleanText(item?.evidenceQuote, MAX_QUOTE_CHARS),
      matchedId: cleanText(item?.matchedId, 160),
      rationale: cleanText(item?.rationale, MAX_RATIONALE_CHARS),
    })),
  };
}

function userMessages(conversation) {
  return [
    ...(Array.isArray(conversation?.recent) ? conversation.recent : []),
    ...(Array.isArray(conversation?.fresh) ? conversation.fresh : []),
  ]
    .filter((item) => item?.role === "user")
    .map((item) => String(item.text || ""))
    .filter(Boolean);
}

function messageCounts(conversation) {
  const count = (items) => (Array.isArray(items) ? items : []);
  const recent = count(conversation?.recent);
  const fresh = count(conversation?.fresh);
  return {
    recent: recent.length,
    fresh: fresh.length,
    recentUsers: recent.filter((item) => item?.role === "user").length,
    freshUsers: fresh.filter((item) => item?.role === "user").length,
    total: recent.length + fresh.length,
  };
}

function compactResults(values, fields) {
  return (Array.isArray(values) ? values : []).slice(0, 100).map((value) =>
    Object.fromEntries(fields.map((field) => [field, cleanText(value?.[field], 160)])),
  );
}

async function appendJSONL(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const handle = await fs.open(file, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
  } finally {
    await handle.close();
  }
}

function cleanText(value, limit) {
  return String(value || "").trim().slice(0, limit);
}

function normalize(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function invalidReview(message) {
  const error = new Error(`Session memory review invalid: ${message}`);
  error.code = "SESSION_MEMORY_REVIEW_INVALID";
  return error;
}
