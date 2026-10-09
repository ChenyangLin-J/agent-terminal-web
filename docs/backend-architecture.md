# Agent Web service ownership

Agent Web mounts Platform's Session application and Runtime. Its backend adapts
product protocols and owns product data and side effects. `server.js` remains the
composition and route entry; extracted services have explicit inputs and do not
import the running server.

## Runtime and product state

| Source/module | Authority |
| --- | --- |
| Native Codex thread | Durable transcript, thread/Turn IDs and native status |
| Platform `AppServerConnection` | JSON-RPC parsing, pending calls, stream writes, process lifecycle and bounded teardown |
| Platform `AgentSessionKernel` | Live/detached/deferred Runtime state, execution queue, steer/interrupt, approval routing and Runtime leases |
| `lib/codex-app-server-client.js` | Product launch defaults and event compatibility; the legacy thread client remains for the configured rollback kernel |
| `lib/platform-app-server-client.js` | Thin facade over the Platform kernel and authorized provider extensions; no nested legacy client or second execution queue |
| `lib/agent-runtime-release.js` | Orders unsubscribe of an old Web attachment before reacquiring its native thread; never closes the shared connection |
| `lib/agent-turn-projection.js` | Product requirement text/status and restoration; queued descriptions reflect Runtime work and do not execute it |
| `lib/agent-session-commands.js` | Product command dispatch to supplied services and Runtime primitives |
| `lib/agent-session-state.js` | Product Session records and ordered title updates across persistence, native names and live attachments |
| `lib/json-state-file.js` | Product file reads, unique-temp atomic writes and damaged-file errors |

Platform's synchronous `describeRuntime()` provides the adapter's current view
without attaching, spawning or renewing a Runtime lease. Raw native notifications
remain available for product transcript projection and realtime extensions;
execution state comes from Platform. Fork adoption retains the same Web attachment
through an explicitly authorized raw fork and binding update. Unknown extensions
stay transport calls rather than a new state machine.

When the Platform kernel is selected, its lease is authoritative. Web supplies a
host-activity predicate for startup, Side Chat and realtime work, projects the
release event into its product record, and reads the expiry from the kernel.
Only the rollback client uses the Web lease timer. A released attachment closes
after native unsubscribe, and queued calls recheck that closure before resuming.

The kernel switch and persisted `runtimeKernel` select the actual implementation.
Legacy behavior remains available for rollback. A capability that Platform already
owns should be consumed through its public APIs before adding a Web implementation.
Product authorization, paths, credential values, memory, account services and
deployment decisions stay here.

## Replies and completion effects

Solicited WebSocket replies carry the incoming `idempotencyKey`, including command,
Side Chat, relation, subagent and voice metadata results. The browser matches both
operation ID and expected response type. A broadcast cannot complete a pending
read, and another operation's error cannot reject it. Audio streaming remains
receipt-free. Existing durable mutation receipts protect retries after an unknown
result; request correlation and mutation idempotency are separate responsibilities.
Command retries return a correlated completion notice without repeating the
operation. Receipts retain command names and public status metadata, not account
details, inventories or command result bodies.

Before a completion updates previews, product requirements, memory processing or
notifications, its Turn identity must match the current projection and must not
already be completed. Completion before either a start or steer response is valid; those responses do
not set Platform execution state. Public snapshots, receipts, Home responses and
stop/busy guards read the facade's synchronous `describeRuntime()`. Requirements
retain only product text/status; a rejected start marks its requirement failed.
The configured legacy rollback client still projects its actual active Turn ID.
Native user messages retain the browser operation identity through
`clientUserMessageId`. Product follow-up wrappers stay in the provider prompt and
are removed from transcript presentation, preserving the original user text. An interrupted client release waits
for completion before unsubscribe, with a bounded wait and an observable failure.

## Stores and trust boundaries

Web attachment records, settings, title overrides, archive overrides, shares,
favorites and Runtime bindings keep their existing JSON formats and locations.
Only `ENOENT` initializes a missing store. Malformed JSON, invalid root shapes and
other read errors block a mutation and preserve the file for recovery. Writes use
private files and unique temporary names with cleanup on failure. Async title
updates serialize file, native-name and live-view effects for the same thread.
Coordination is process-local; atomic rename does not imply cross-process locking.
The Home-owned favorites namespace remains a shared-file boundary.

Derived preview/process caches are separate from authoritative user state and can
be regenerated. JSONL conversation pages, result previews and usage reuse bounded
in-memory derived results (32 entries, 32 MiB of serialized payload). Every hit
checks device/inode, size, modification and change timestamps; writes or atomic
replacement invalidate the entry. Simultaneous reads share a Promise; failed or
concurrently changed reads are not retained. Pagination slices parsed turns and
never mutates the rollout.

Agent Web process reads reuse completed native thread/turn data before reading a
Session, coalesce concurrent requests and cap retained results at 50 turns / 8 MiB.
The shared tabbed detail card opens active Turns and collapses completed Turns
by default; an explicit user disclosure choice remains authoritative.
It reads historical execution items only when the execution tab opens, restores
missing expanded items after refresh, and reports execution counts only after a
full read. The product-owned memory tab supplies exact citations and the existing
in-site preview; selecting it never initiates a process read. One card shares the
collapse control and content area, with bounded completed output and naturally
wrapping one-row file entries.
Completed previews read on selection, focus or changed catalog metadata; active
previews continue polling. Hidden pages stop polling and slow reads cannot overlap.

Local Markdown editing keeps its existing optimistic version
checks; it cannot guarantee arbitration with arbitrary external editors.

Browser APIs retain Private Auth. Home gateway routes retain loopback plus token
validation, local MCP endpoints remain loopback-only, and public shares retain
token access. Credential revocation deliberately closes a provider immediately;
normal process draining must not postpone revocation.

## Verification and package adoption

Shared state-machine tests belong to Platform. Web tests cover mounting, transport
translation, thread isolation, product projections, persistence and side effects.
`test/app-server-client.test.js`, `platform-app-server-client.test.js`,
`agent-runtime-release.test.js`, `agent-turn-projection.test.js`,
`agent-session-commands.test.js`, `agent-web-connection.test.js` and the service
integration fixtures exercise those boundaries without inspecting function layout.

The formal dependency is Platform v0.43.0, including the `describeRuntime()` and
release/lease contracts used by this adapter. Normal builds and tests use that
immutable published package. For an unreleased paired build, set
`AGENT_PLATFORM_CANDIDATE` to the Platform worktree for both the browser build and
server tests. Isolated test launchers must forward that explicit path; candidate
success does not authorize production activation. Memory System remains an
independent product dependency, resolved with `AGENT_MEMORY_SYSTEM_ROOT` outside
a normal sibling checkout.

Full test runs that launch many local fixture servers can use
`npm test -- --test-concurrency=4` to bound process load. Finish tests/builds before
recording a preview so generated assets are stable.

### Catalogue events and local file previews

The product opts into independent Session startup and requests 20 catalogue rows
at a time. Opening a Session and creating a local draft do not await model
metadata; execution options and the first send load it on demand. The first send
still applies the configured model/effort/access before starting the Turn.
Memory management, integration settings and dictation scripts load on entry;
Agent execution memory remains a backend concern. A native attachment picker
and draft creation remain local interactions without a page reload. The build
maps Platform's optional lazy Markdown entry, activates content-addressed assets
through generated HTML/manifest, and retains preceding chunks for open tabs.

`lib/platform-session-events.js` narrows status broadcasts to catalogue metadata and exposes authenticated bounded SSE replay. The browser applies these updates without subscribing to every Runtime. `public/platform-agent-web-catalog.js` owns visibility, reconnect and metadata-only reconciliation; the adapter preserves newer event rows against delayed HTTP snapshots and rejects earlier revisions or completed Turn IDs. Restart identifiers reset process-local ordering.

Catalogue requests share a lazy request-local snapshot of settings, Web records,
title/archive overrides and favorites. Each authoritative store is read and
normalized at most once per request; the next request reads it again. No process
cache replaces those stores. `GET /api/platform/sessions?limit=20` uses the existing
decimal `cursor` / `nextCursor` contract with a validated limit of 1–50. Omitting
`limit` retains the existing 50-row response and first native metadata page.
Explicit bounded requests extend native metadata pages only to the requested
window plus one row, without hydrating historical conversations. Search retains
its existing result limits. Generated JS/CSS/font filenames with the build's
eight-character content hash receive immutable year-long caching. Generated HTML
and the manifest use `no-cache`; other unversioned files keep `max-age=0`.
Root/index routes serve the activated generated HTML, and fixed legacy entry
asset URLs redirect through the current manifest. A missing build returns 503.

`lib/platform-file-preview.js` resolves authenticated local files within the real workspace root and returns shared Platform preview descriptors and raw media. Symlinks outside the root are rejected. Text size is checked before reading; active HTML never becomes an unsandboxed same-origin raw document. Preview state and latest-request cancellation belong to the product controller.

The Web adapter opts into Platform Host submission feedback. Preparation and
acknowledgement are bounded; input recovery uses the existing Composer error
contract, while an unknown result retains the same operation ID. The adapter
maps native echo IDs (with a baseline-aware compatibility fallback) and never
changes execution status for a temporary message. A WebSocket handshake also has
a deadline, and cancelled preparation cannot issue a late native submit.

Web attachment IDs are transport bindings for a native logical thread. A live
catalogue entry for the same thread replaces released metadata and supplies the
new binding to Platform's selected Session recovery. Old deep-link reads use the
actual attachment returned by the server before subscribing. Catalogue activity,
foreground recovery and restart revision changes reconcile only the selected
body; they do not open connections or load transcripts for other history rows.
