# Home Agent Gateway

Home accesses durable Agent conversations through the narrow internal API below. It is not a browser API and it is not a generic upstream proxy.

Home must call Agent Web directly over loopback, include `x-home-agent-gateway-token`, and authenticate its browser request before making that call. Agent Web accepts the route only when both conditions hold:

- `HOME_AGENT_GATEWAY_TOKEN` is configured and matches the request header.
- The peer is direct loopback with no forwarded headers.

Requests without this boundary receive `404`; an unset token produces `503` for an otherwise eligible gateway request. The API always sends `Cache-Control: private, no-store`.

| Method | Path | Result |
| --- | --- | --- |
| `GET` | `/api/home/agent/sessions` | `{ sessions }` with durable Codex thread `id` and optional live `webSessionId`. |
| `GET` | `/api/home/agent/conversation?sessionId=&attach=&cursor=` | `{ session, messages, hasEarlier, nextCursor, turn, pendingApproval, agentHref }`. `attach` is optional and must match the durable thread; use `nextCursor` to load earlier messages. Assistant messages preserve async `questions` and `completedAt`. |
| `POST` | `/api/home/agent/turns` | Accepts `{ sessionId?, attach?, text, requestId }`; returns `202` with the durable thread and current turn. A missing historical runtime is resumed through the existing App Server path. |

`sessionId` is the durable Codex thread ID. `webSessionId`/`attach` identifies an ephemeral Agent Web runtime and must never be treated as the conversation identity.

Turn submission deliberately rejects a currently active turn with `409`; it does not steer or queue Home input. An attach/thread mismatch and a reused `requestId` with different content also return `409`. Input validation returns `400`, startup timeout returns `504`, and App Server failures return `502`.

Before Agent Web sends upstream, it writes a `pending` request record; accepted request IDs are retained for 24 hours in `home-agent-turn-requests.json` under the Codex state root. A retry after restart returns an accepted record without another turn. A surviving `pending` record is intentionally fail-closed with `409`: upstream delivery may be unknown, so the user must inspect the durable thread in Agent before proceeding. Deterministic failures before `submitAppServerPrompt` release the reservation, so the same request ID can be retried. The ledger contains request fingerprints and response metadata, not browser credentials. It is bounded to 200 entries and uses mode `0600`. If this ledger cannot be written, Agent Web does not begin a new upstream submission or claim durable acceptance. While an admission is in progress, same-ID/same-payload calls share one Promise; a reused ID with different content receives `409`. A separate in-flight request for the same durable thread or attached web Session also receives `409`, before any App Server await can start a second turn.

For isolated tests or development harnesses, set `AGENT_CODEX_STATE_ROOT`; `AGENT_STATE_ROOT` uses its `codex/` child. These avoid repurposing a real user's `HOME` or `CODEX_HOME`.

Deploy this change through the normal Agent Web process. After verification and commit, an external terminal must restart `agent-terminal-web.service` only when no turn is running. An Agent Web session must not restart its own service.
