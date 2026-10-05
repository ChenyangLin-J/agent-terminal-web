import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSessionCommandHandler } from "../lib/agent-session-commands.js";
import { completeTrackedTurn, restoreTurnState } from "../lib/agent-turn-projection.js";
function fixture(extra = {}) {
  const calls = [], responses = [];
  const session = { sessionId: "native", cwd: "/workspace", access: "full", turnState: restoreTurnState({}), appServer: { activeTurnId: "", readConfig: async () => ({ config: { service_tier: "default" } }), setThreadName: async (title) => calls.push(["name", title]), compactThread: async () => calls.push(["compact"]) } };
  const services = { send: () => {
    throw new Error("request reply must use its supplied correlation callback");
  }, cleanCustomTitle: (value) => value.trim(), getAppServerSkills: async () => [{ name: "skill" }], renameSession: async (value, title) => {
    calls.push(["rename", value.sessionId, title]);
    value.title = title;
  }, persistRestorableWebSession: () => calls.push(["persist"]), broadcast: () => calls.push(["broadcast"]), publicSession: (value) => value };
  for (const name of ["Status", "Usage", "Models", "Goal", "GitDiff", "McpInventory", "PluginInventory", "HookInventory"]) services[`appServer${name}`] = async () => ({ fixture: name });
  const handle = createAgentSessionCommandHandler({ ...services, ...extra });
  return { session, calls, responses, run: (value) => handle(session, {}, value, (type, payload) => responses.push({ type, payload })) };
}
test("read commands return structured replies through their request-scoped callback", async () => {
  const f = fixture();
  for (const command of ["/status", "/usage", "/model", "/goal", "/diff", "/mcp", "/plugins", "/hooks", "/skills", "/permissions"]) await f.run(command);
  assert.equal(f.responses.length, 10);
  assert.ok(f.responses.every((value) => value.type === "app-command-result"));
  assert.equal(f.responses[0].payload.fixture, "Status");
  assert.deepEqual(f.responses[8].payload.skills, [{ name: "skill" }]);
  assert.deepEqual(f.calls, []);
});
test("rename and fast mode apply product effects while compact is rejected during an active runtime Turn", async () => {
  const f = fixture();
  await f.run("/rename New title");
  assert.equal(f.session.title, "New title");
  assert.deepEqual(f.calls, [["rename", "native", "New title"]]);
  await f.run("/fast");
  assert.equal(f.session.appServiceTier, "priority");
  await f.run("/compact");
  assert.ok(f.calls.some((call) => call[0] === "compact"));
  f.session.appServer.activeTurnId = "working";
  await assert.rejects(f.run("/compact"), /当前任务仍在处理/);
  await assert.rejects(f.run("/unknown"), /not available/);
});
test("review completion before its start reply cannot leave a phantom running task", async () => {
  const f = fixture();
  f.session.appServer.startReview = async () => {
    f.session.turnState.turnId = "review";
    completeTrackedTurn(f.session, "review");
    return { turn: { id: "review" } };
  };
  await f.run("/review");
  assert.equal(f.session.turnState.active, false);
  assert.equal(f.session.turnState.lastCompletedTurnId, "review");
  assert.equal(f.session.turnState.requirements[0].status, "completed");
});
