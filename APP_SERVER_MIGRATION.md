# Codex App Server mode

Agent Terminal runs every Session on the `App Server` engine, which uses JSON-RPC
so a follow-up can be attached to an exact Codex turn. The former `Terminal`
(PTY) engine has been removed; legacy Sessions resume as App Server Sessions by
their persisted Codex thread id.

Home and other callers can open an App Server session with:

```text
/?new=1&cwd=.&transport=app-server
```

## Behavior

Agent Web owns one on-demand App Server process and initializes its protocol
connection once. Main Sessions, Side Chats, and homepage catalog operations
create thread-scoped clients over that connection. Each client tracks its own
`threadId`, active `turnId`, queue, notifications, and approval requests.

The shared connection remains alive for the Agent Web process lifetime. Closing
one web Session unsubscribes its thread without terminating other Sessions.

- `新任务` calls `turn/start`.
- `追加当前` calls `turn/steer` with `expectedTurnId`; it cannot silently steer a different turn.
- `下一轮` stays in an application queue and calls `turn/start` only after the current `turn/completed` event.
- If a follow-up reaches the server just after completion, its text is retained and starts as a new turn instead of being lost.
- Notifications and server-initiated approval requests are routed only to the
  client whose `threadId` matches the protocol message.
- Threadless shared notifications never advance an individual Session's
  activity timestamp.
- A shared connection failure marks affected turns as interrupted; opening a
  Session again creates a fresh connection and resumes its persisted thread.
- Idle runtime release is independent from user organization: it leaves the
  Session in the current list as paused. Only explicit `结束` or `归档` actions
  move it out of the current list.
- The latest completed and viewed turn ids are persisted separately so the
  control center can distinguish `新结果` from a viewed, idle Session.

The browser renders agent text, reasoning summaries, command output, file changes, turn state, and errors as readable transcript output. Command and file approvals, permission requests, and text questions appear as an explicit decision card. Voice input, uploads, push notifications, session titles, archive, and Home deep links continue to use the shared web UI.

## Current limits

- App Server mode shows the structured events needed by the current workflow, not every experimental event type.
- Multi-question tool prompts use a compact text answer field rather than a dedicated form for every question.

## Verification

Automated tests cover exact-turn steering, rejected late steering, immediate
completion races, queue ordering, shared-process counts, concurrent thread
isolation, approval routing, unsubscribe behavior, and
approval UI wiring. Release verification starts two concurrent ephemeral
threads on one real App Server process and confirms that each receives only its
own final response. Browser checks cover mobile layout, approval interaction,
reconnect, a same-turn follow-up, and a queued second turn.
