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

## Personal openings

The same protected loopback prefix now also provides a personal
opening gateway. Home owns the context and saved result; Agent Web owns the
restricted durable thread. The Home product and API contract is in
`home-portal/docs/personal-agent-mvp.md`.

| Route | Behavior |
| --- | --- |
| `GET /api/home/agent/activity?from=…&to=…&limit=…` | Bounded recent conversations, with user/assistant authors, exact timestamps and partial coverage. Uses `[from,to)`. Initial opening turns are excluded; user continuation is included for all turn states. |
| `POST /api/home/agent/openings` | `requestId`, `date`, `period` (`morning`/`evening`), bounded `prompt`; durable reservation before submission. Same request/payload is reused, a changed payload conflicts. One background generation, interactive turns take precedence at admission. |
| `GET /api/home/agent/openings/:requestId` | Read the completed/pending/failed/uncertain result. Uncertain jobs with an exact stored thread/turn ID may reconcile from durable history without submitting another turn. |

Requests use a thread-scoped client over the existing shared App Server, never
the mutable catalog client for `thread/start`. Configuration discovery is
required; shell, unified exec, discovered MCP, Apps, Plugins and web search are
disabled for generation. The thread uses read-only sandbox and approval never;
the turn uses the installed protocol's `sandboxPolicy` and a one-turn JSON
output schema. Unsupported restrictions fail rather than falling back to full
access. Actual native capability behavior and generation quality remain to be
verified in a candidate environment with a real model.

The runtime cwd is `WORKSPACE_ROOT/.personal-agent-runtime`, created on demand.
It stays inside the existing Home resume boundary. User continuation uses the
existing `/turns` route and normal Session policy; the generation schema is not
carried into replies. Token usage is saved when the provider reports it.

`home-personal-agent-openings.json` in the configured Codex state root has mode
0600. Thread and accepted turn IDs are persisted before publishing a result;
pending/running records after a restart are uncertain. Recovery matches the
exact turn on a bounded history page. Missing identity or missing history is
left uncertain for inspection. Ledger corruption fails closed. Home can
reconcile a result through its own endpoint using the original request ID.

Validation uses an isolated state/workspace, fake App Server protocol and no
production credentials. It covers admission, idempotency, restart recovery,
source authors/timestamps and a complete opening-to-Home-reply flow while one
shared App Server remains alive. The fixture tests do not activate production. Both services now load the shared
gateway token from the private environment file. Home was reloaded at 22:17
and Agent Web was restarted externally at 22:25 on 2026-10-04 (Asia/Shanghai);
the authenticated Home session gateway returns 200. Real activity reads return
bounded personal conversations with no failed reads in the checked page.
Native generation and follow-up acceptance remain pending: real Home context
exposed an overlong prompt, whose complete input budget is corrected and deployed in Home as of 22:40.
A one-off live check now waits for all interactive Turns to finish before
submitting generation; it does not bypass interactive admission or restart
either production service.
Agent Web itself does not need another restart for that Home fix. An Agent Web
Session never restarts the Agent service.

Home conversation responses for opening threads replace their initial machine
prompt and JSON with the natural opening text. Session titles use the opening's
date and period. Actual user follow-ups stay in the same durable thread and are
kept as activity evidence; pure generated openings do not consume the 12 real
conversation slots. Activity checks at most 36 recent candidates, each up to
12 turns, and continues to report partial coverage. The opening schema and
validation accept up to 350 Unicode characters (typically 150–350 according to
available evidence, with shorter text allowed when evidence is sparse).
