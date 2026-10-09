/** Public conversation first; completed execution details remain in their owning process endpoint. */
export function projectSessionTranscript(items = [], { activeTurnId = '' } = {}) {
  const details = new Set();
  const visible = [];
  for (const item of items) {
    const publicMessage = item.type === 'user' || (item.type === 'assistant'
      && ['final_answer', 'async_question', 'async_message'].includes(item.phase));
    const active = Boolean(activeTurnId && item.turnId === activeTurnId);
    const nativeTurn = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(item.turnId || '');
    if (nativeTurn && !active) details.add(item.turnId);
    // Legacy details have no addressable process endpoint, so keep their data.
    if (publicMessage || active || !nativeTurn) visible.push({ ...item });
  }
  return { items: visible, technicalDetailsAvailable: [...details] };
}
