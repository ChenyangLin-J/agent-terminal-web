# Codex App Server mode

Agent Terminal provides two per-session engines:

- `App Server` is the default and uses JSON-RPC so a follow-up can be attached to an exact Codex turn.
- `Terminal` remains available for the full interactive Codex CLI in a PTY.

Select the engine on the session start screen. Home and other callers can also open an App Server session with:

```text
/?new=1&cwd=.&transport=app-server
```

## Behavior

`lib/codex-app-server-client.js` owns one App Server process per live web session. It initializes the connection, starts or resumes a thread, tracks the active `turnId`, and persists the transport and thread id after the first turn starts so the web session can be restored after a service restart.

- `新任务` calls `turn/start`.
- `追加当前` calls `turn/steer` with `expectedTurnId`; it cannot silently steer a different turn.
- `下一轮` stays in an application queue and calls `turn/start` only after the current `turn/completed` event.
- If a follow-up reaches the server just after completion, its text is retained and starts as a new turn instead of being lost.

The browser renders agent text, reasoning summaries, command output, file changes, turn state, and errors as readable terminal output. Command and file approvals, permission requests, and text questions appear as an explicit decision card. Voice input, uploads, push notifications, session titles, archive, Text view, and Home deep links continue to use the shared web UI.

## Current limits

- Raw terminal keystrokes and CLI slash commands are available only in Terminal mode.
- App Server mode shows the structured events needed by the current workflow, not every experimental event type.
- Multi-question tool prompts use a compact text answer field rather than a dedicated form for every question.
- Terminal remains available as a manual fallback for workflows that need the full interactive CLI.

## Verification

Automated tests cover exact-turn steering, rejected late steering, immediate completion races, queue ordering, the engine switch, and approval UI wiring. Browser checks cover mobile layout, approval interaction, reconnect, a same-turn follow-up, and a queued second turn.
