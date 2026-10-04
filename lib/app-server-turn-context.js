export function buildAppServerTurnAdditionalContext(personalMemoryContext) {
  return personalMemoryContext &&
    typeof personalMemoryContext === "object" &&
    !Array.isArray(personalMemoryContext)
    ? personalMemoryContext
    : {};
}
