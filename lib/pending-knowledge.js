export function pendingKnowledgeContext(changes, options = {}) {
  const allowedTypes = new Set(
    (Array.isArray(options.types) ? options.types : ["personal_memory", "project_rule", "skill"])
      .map(String),
  );
  const pending = (Array.isArray(changes) ? changes : [])
    .filter((change) => change?.status === "pending" && allowedTypes.has(change.targetType))
    .map((change) => ({
      id: change.id,
      targetType: change.targetType,
      targetPath: change.targetPath,
      entryId: change.entryId,
      action: change.action,
      before: change.before,
      after: change.after,
      rationale: change.rationale || "",
      evidence: (change.evidence || []).slice(0, 6),
      confidence: Number(change.confidence) || 0,
    }));
  const limit = Number(options.limit);
  return Number.isFinite(limit) && limit > 0 ? pending.slice(0, limit) : pending;
}

export function pendingMergeInstructions() {
  return [
    "Before emitting a candidate, compare it with every pending proposal supplied below.",
    "If an existing pending proposal already covers the new information, emit nothing.",
    "If new evidence materially refines the same statement for the same target type and target document, emit one complete consolidated candidate and set mergePendingId to that pending proposal id.",
    "A consolidated candidate replaces the pending candidate's proposed content, so it must remain self-contained and preserve every still-valid point.",
    "Do not merge merely related but independently useful facts, different target documents or types, different actions, sensitive and unrelated subjects, or contradictions. Leave mergePendingId empty for a genuinely separate candidate.",
    "Never use an approved, rejected, reverted, superseded, or unknown id as mergePendingId.",
  ].join("\n- ");
}
