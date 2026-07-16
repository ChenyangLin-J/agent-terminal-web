# Codex App Server migration

Agent Terminal currently runs the interactive Codex CLI inside a PTY. The browser sends text to that terminal and cannot bind a follow-up to an exact Codex turn.

The App Server migration replaces keystroke injection with JSON-RPC while keeping the existing PTY path available until the structured client covers the same behavior.

## Current experiment

`lib/codex-app-server-client.js` implements the control layer without changing production transport:

- initializes one App Server connection;
- starts or resumes a thread;
- starts a turn and retains its exact `turnId`;
- steers only when `expectedTurnId` matches the active turn;
- keeps queued prompts in the web client and starts them after `turn/completed`;
- surfaces notifications and server-initiated requests for the future UI;
- rejects a late steer instead of silently turning it into another turn.

The current PTY UI also tracks the original request, current-turn follow-ups, and queued prompts. This improves completeness immediately, but the PTY cannot provide the exact turn guarantee of App Server.

## Remaining production work

1. Session process
   - Add an `app-server` session type beside the current `pty` type.
   - Persist the transport type, `threadId`, active `turnId`, and pending prompts.
   - Resume App Server threads with `thread/resume` after a service restart.

2. Structured output
   - Render agent message deltas, reasoning summaries, command output, file changes, plans, and errors from App Server notifications.
   - Keep the current text view, but populate it from structured items rather than terminal escape sequences.

3. User decisions
   - Add UI for command approval, file-change approval, permission requests, MCP elicitation, and tool questions.
   - Send the corresponding JSON-RPC response to the server request id.

4. Follow-up delivery
   - Make “追加当前” call `turn/steer` with `expectedTurnId`.
   - If the turn already completed, keep the text and let the user choose whether to start it as the next turn.
   - Make “下一轮” an application queue that calls `turn/start` only after `turn/completed`.

5. Compatibility
   - Replace `/status` and `/permissions` terminal shortcuts with structured status and permission controls.
   - Preserve uploads, voice transcription, push notifications, session naming, archive, and Home deep links.

6. Rollout
   - Keep PTY as the default while App Server is behind a per-session feature switch.
   - Test new sessions, resume, concurrent browser reconnects, approvals, rejected late steers, queue ordering, service restarts, and mobile layout.
   - Switch the default only after the structured path passes those checks; retain PTY as a fallback during the first rollout period.
