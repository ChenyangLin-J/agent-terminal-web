import assert from "node:assert/strict";
import test from "node:test";
import { acceptTrackedTurnCompletion, completeTrackedTurn, restoreTurnState, interruptedTurnStateAfterProcessLoss, turnRequirement } from "../lib/agent-turn-projection.js";
function working() {
  const state = restoreTurnState({ active: true, turnId: "current", sequence: 1, lastCompletedTurnId: "previous" });
  state.requirements = [turnRequirement(state, "current request", "original", "working")];
  state.queuedTurns = [turnRequirement(state, "next request", "queued", "queued")];
  return { turnState: state };
}
test("late and duplicate completion cannot finish another task or consume its queue", () => {
  const session = working(), before = structuredClone(session);
  assert.equal(acceptTrackedTurnCompletion(session.turnState, "previous"), false);
  assert.equal(completeTrackedTurn(session, "older"), false);
  assert.deepEqual(session, before);
  assert.equal(completeTrackedTurn(session, "current"), true);
  assert.equal(session.turnState.requirements[0].text, "next request");
  assert.equal(session.turnState.requirements[0].status, "working");
  const completed = structuredClone(session);
  assert.equal(completeTrackedTurn(session, "current"), false);
  assert.deepEqual(session, completed);
});
test("a stopped task cancels its requirements and promotes the next product description once", () => {
  const session = working(), original = session.turnState.requirements[0];
  assert.equal(completeTrackedTurn(session, "current", { stopped: true }), true);
  assert.equal(original.status, "cancelled");
  assert.equal(session.turnState.lastStoppedTurnId, "current");
  assert.equal(session.turnState.active, true);
  assert.equal(session.turnState.turnId, "");
});
test("completion before the start response is projected, and process loss preserves resumable requirements", () => {
  const session = working();
  session.turnState.turnId = "";
  assert.equal(completeTrackedTurn(session, "fast-turn"), true);
  const lost = interruptedTurnStateAfterProcessLoss({ active: true, turnId: "running", requirements: [{ text: "keep this request", status: "working" }] }, "2026-10-05T00:00:00Z");
  assert.equal(lost.active, false);
  assert.equal(lost.interrupted, true);
  assert.equal(lost.requirements[0].status, "interrupted");
  assert.equal(lost.requirements[0].text, "keep this request");
  assert.equal(acceptTrackedTurnCompletion(lost, ""), false);
});
