/** Product requirement projection. Execution/queue ownership stays with the Runtime. */
const MAX_TURN_REQUIREMENTS = 20;
const cleanClientLogValue = (value, limit) => String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, limit);
const clampInteger = (value, min, max, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export function acceptTrackedTurnCompletion(state, turnId) {
  if (!state || !turnId || turnId === state.lastCompletedTurnId) return false;
  return !state.turnId || state.turnId === turnId;
}

export function completeTrackedTurn(session, turnId, { stopped = false } = {}) {
  const state = session.turnState;
  if (!acceptTrackedTurnCompletion(state, turnId)) return false;
  state.lastCompletedTurnId = turnId || state.lastCompletedTurnId;
  state.turnId = turnId || state.turnId;
  state.stopping = false;
  if (stopped) state.lastStoppedTurnId = turnId || state.turnId;
  state.interrupted = false;
  state.interruptedAt = "";
  for (const requirement of state.requirements) requirement.status = stopped ? "cancelled" : "completed";

  const next = state.queuedTurns.shift();
  if (next) {
    state.sequence += 1;
    next.status = "working";
    state.requirements = [next];
    state.active = true;
    state.turnId = "";
  } else {
    state.active = false;
  }
  return true;
}

export function turnRequirement(state, text, kind, status) {
  state.requirementSequence += 1;
  return {
    id: `requirement-${state.requirementSequence}`,
    text: String(text).slice(0, 4_000),
    kind,
    status,
  };
}

export function trimTrackedRequirements(state) {
  if (state.requirements.length > MAX_TURN_REQUIREMENTS) {
    state.requirements.splice(1, state.requirements.length - MAX_TURN_REQUIREMENTS);
  }
  if (state.queuedTurns.length > MAX_TURN_REQUIREMENTS) {
    state.queuedTurns.splice(0, state.queuedTurns.length - MAX_TURN_REQUIREMENTS);
  }
}

export function restoreTurnState(value) {
  const input = value && typeof value === "object" ? value : {};
  return {
    active: Boolean(input.active),
    stopping: false,
    interrupted: Boolean(input.interrupted),
    interruptedAt: cleanClientLogValue(input.interruptedAt, 100),
    turnId: cleanClientLogValue(input.turnId, 100),
    lastCompletedTurnId: cleanClientLogValue(input.lastCompletedTurnId, 100),
    lastStoppedTurnId: cleanClientLogValue(input.lastStoppedTurnId, 100),
    sequence: clampInteger(input.sequence, 0, 1_000_000, 0),
    requirementSequence: clampInteger(input.requirementSequence, 0, 1_000_000, 0),
    requirements: restoreRequirements(input.requirements),
    queuedTurns: restoreRequirements(input.queuedTurns),
  };
}

function restoreRequirements(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-MAX_TURN_REQUIREMENTS).map((item, index) => ({
    id: cleanClientLogValue(item?.id, 100) || `restored-requirement-${index + 1}`,
    text: String(item?.text || "").slice(0, 4_000),
    kind: ["original", "followup", "queued"].includes(item?.kind) ? item.kind : "followup",
    status: ["working", "queued", "completed", "failed", "interrupted", "cancelled"].includes(item?.status)
      ? item.status
      : "working",
  }));
}

export function interruptedTurnStateAfterProcessLoss(value, fallbackTime = "") {
  const state = restoreTurnState(value);
  const hasUnfinishedRequirement = state.requirements.some((item) =>
    ["working", "queued", "interrupted"].includes(item.status),
  );
  const incompleteTurn =
    state.active ||
    state.interrupted ||
    Boolean(state.turnId && state.turnId !== state.lastCompletedTurnId && hasUnfinishedRequirement);
  state.active = false;
  if (!incompleteTurn) return state;

  state.interrupted = true;
  state.interruptedAt = state.interruptedAt || cleanClientLogValue(fallbackTime, 100) || new Date().toISOString();
  for (const requirement of state.requirements) {
    if (requirement.status === "working") requirement.status = "interrupted";
  }
  return state;
}

export function publicTurnState(state) {
  return {
    active: Boolean(state?.active),
    stopping: Boolean(state?.stopping),
    interrupted: Boolean(state?.interrupted),
    interruptedAt: state?.interruptedAt || "",
    turnId: state?.turnId || "",
    lastCompletedTurnId: state?.lastCompletedTurnId || "",
    lastStoppedTurnId: state?.lastStoppedTurnId || "",
    requirements: state?.requirements || [],
    queuedTurns: state?.queuedTurns || [],
  };
}
