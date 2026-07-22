export function orderKnowledgeChanges(changes = []) {
  return [...(Array.isArray(changes) ? changes : [])].sort((left, right) => {
    const pendingOrder = Number(right.status === "pending") - Number(left.status === "pending");
    if (pendingOrder) return pendingOrder;
    return changeTime(right) - changeTime(left);
  });
}

function changeTime(change) {
  const value = change?.status === "pending"
    ? change.createdAt
    : change?.resolvedAt || change?.appliedAt || change?.createdAt;
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}
