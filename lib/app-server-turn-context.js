export function buildAppServerTurnAdditionalContext(orchestrationMode, personalMemoryContext) {
  const mode = orchestrationMode === "manual" ? "manual" : "auto";
  const orchestrationContext =
    mode === "auto"
      ? '<multi_agent_mode mode="auto">The user enabled Auto orchestration for this Session. Apply the Agent Web multi-agent policy and delegate only when it is a net benefit.</multi_agent_mode>'
      : '<multi_agent_mode mode="manual">Do not spawn sub-agents unless the user explicitly requests delegation in this task.</multi_agent_mode>';
  const memoryContext =
    personalMemoryContext && typeof personalMemoryContext === "object" && !Array.isArray(personalMemoryContext)
      ? personalMemoryContext
      : {};

  return {
    ...memoryContext,
    "multi-agent-mode": {
      kind: "application",
      value: orchestrationContext,
    },
  };
}
