#!/usr/bin/env node

const notifyUrl = process.env.AGENT_NOTIFY_URL || "";
const webSessionId = process.env.AGENT_WEB_SESSION_ID || "";
const rawEvent = process.argv.at(-1);

if (!notifyUrl || !webSessionId || !rawEvent) process.exit(0);

try {
  const event = JSON.parse(rawEvent);
  if (event?.type !== "agent-turn-complete") process.exit(0);

  await fetch(notifyUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webSessionId, event }),
    signal: AbortSignal.timeout(8_000),
  });
} catch {
  // Notifications must never interfere with the Codex turn that just completed.
}
