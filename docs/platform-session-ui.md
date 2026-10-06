# Agent Web Session UI ownership

Agent Web consumes Platform's `SessionApplication`, Session Host controller, Composer utilities, and Side Chat/Subagent/Realtime panels. Minimal Host uses the same application. The old DOM Session list, transcript, input, queue, request UI and connection presentation are removed from this repository.

## Modules

| Module | Responsibility |
| --- | --- |
| `public/platform-agent-web-entry.jsx` | Public application assembly, URL navigation, capabilities and callbacks |
| `public/platform-agent-web-adapter.js` | Agent Web API/event projection, lazy drafts and historical preview; no Session rendering |
| `public/agent-web-connection.js` | Agent Web WebSocket lifecycle, bounded reconnect and operation responses |
| `public/platform-agent-web-resources.js` | Upload and authorized local-resource URLs |
| `public/platform-agent-web-voice.js` | Existing recording factory, transcription endpoint and recovery context |
| `public/platform-agent-web-notifications.js` | Product notification target and explicit push subscription |
| `public/platform-agent-web-product-controller.js` | Product account/service operations |
| `public/platform-agent-web-product-extensions.jsx`, `.css` | Memory, integrations, workspaces, updates, sharing and Session tools |
| `lib/platform-session-routes.js` | Authenticated HTTP projection for the shared Host Kit |
| `lib/platform-session-metadata.js` | Bounded, deduplicated model/catalog and workspace configuration reads; no native thread allocation |
| `lib/session-references.js` | Native Session reference validation, canonical metadata and bounded public context |
| `lib/session-operation-receipts.js` | Bounded durable operation receipts, hashes and public results |
| `lib/memory-system-library.js` | Product memory dependency location |
| `lib/personal-agent-gateway.js` | Product personal openings and bounded public conversation activity |

Backend Runtime and product service ownership is documented in
[`backend-architecture.md`](backend-architecture.md).

Platform owns common interaction and presentation, selection protection, snapshot/event recovery, retry identity, and UI state. Agent Web owns its server/API/WS protocol, Runtime choice, authentication, native thread identity, persistence, memory, integrations, local-file access, notification service and deployment. Product endpoints and recording/account services must not be embedded in Platform components.

Historical process details are read lazily through the authenticated product projection, including previews with no live Runtime. Reading a completed record never resumes a Codex thread. Editing a user message forwards its existing authorized attachments to the product's Edit/Fork validation.

When a released or historical preview is resumed, its live attachment becomes authoritative. Stop preview polling, reject pending preview reads after promotion, and clear the released/paging caches before subscribing to live events. Native transcript IDs replace synthesized preview IDs rather than duplicating them. The catalog prefers a live attachment over released records of the same native thread, then the most recent attachment; subsequent sends and reloads keep that target.

New Conversation opens a browser-local draft immediately, independently of the history request. Draft model, reasoning effort, permissions, Fast mode, text, favorite and archive state survive reload in the same browser. The authenticated metadata endpoint reads the actual Codex workspace defaults and selectable model catalog without allocating a native thread. First submission creates the backend Session once and applies the chosen execution profile before submitting the Turn. Empty drafts can be archived locally; both local drafts and backend Sessions disappear from Recent when archived and remain accessible through Search and History with Include Archived enabled.

Context reads use token notifications or stored native usage and a reported/configured context window. Missing capacity remains unknown; an unsent draft shows Not Started. Context reads avoid the unrelated account quota/status bundle, and the shared Composer drops older popup results when the Host publishes a newer usage snapshot. Catalog/configuration reads share bounded caches and in-flight requests, including a timeout and short retry after failures.

Composer context extensions read product usage from the public Host snapshot, guarded by the selected UI Session ID. The shared presentation view omits product token fields; reading usage from that view loses the meter even when the backend has supplied it. Empty drafts omit compaction, and available Fast tiers supply their own tooltip description.

Session rows supply the same reference contract as Personal Workbench: sidebar drag and `@` search produce removable Composer chips. Agent Web reauthorizes `agent-web + native threadId` against its current account's live or stored Codex history before submission, rejects self/foreign/archived/missing targets, and includes bounded recent public context in the model input. Messages persist the public pointer and hide the input envelope; edit/queue preserve it. Opening a message reference navigates to the target. Released Sessions retain their selected UI identity in the URL so refresh recovers the same draft/reference state.

The private `submitAppServerPrompt` helper receives an options object after `requirementText`. Resolved references use `options.references`; direct, startup-queued and edit/fork submissions use the same field. Product gateway admission controls can share this object without interpreting their options as a reference array.

Home's conversation and personal activity gateways remain product-owned backend APIs. Their user-message projections use the same Session reference parser: model-only reference envelopes and excerpts are hidden, user text is retained, and reference-only input does not become authored activity. The gateway contract and isolated integration coverage are described in `docs/home-agent-gateway.md`.

Account usage remains a product-owned dialog. Opening it reads the existing `/usage` response automatically and presents available quota windows, remaining percentage and reset time; refresh uses the same read operation. Missing quota data stays unknown. Slash-command usage results use this presentation too, while the Composer's context usage remains a separate shared control.

The Session menu exposes one Related Sessions entry with Side Chat, Subagent and Thread Relations tabs. Agent Web supports one Side Chat, so the shared panel's internal selector is omitted. Thread Relations reads the existing `session-tree` response on entry and renders named parent/branch/agent rows with read-only navigation. Realtime has a separate dialog showing the shared inline controls immediately, including voice choices and visible permission/connection errors.

Existing `server.js` remains the integration point for Runtime lifecycle and product services. New shared-UI routes and receipt logic are separate modules. A later backend refactor can extract lifecycle, transcript projection, approvals and persistence in independent steps while preserving those contracts; moving product scheduling or memory policy into Platform would blur this boundary.

## Build and candidate verification

Agent Web pins Platform v0.37.0, which exports `./session-host`, the shared Session application and the authoritative Runtime description/lease contract. A normal install, build and test use the published package:

```bash
npm ci --include=dev
npm run build:session-app
npm test
```

For later unreleased Platform changes, an explicit local candidate remains available without rewriting the formal pin:

```bash
AGENT_PLATFORM_CANDIDATE=/absolute/path/to/platform-candidate npm run build:session-app
AGENT_PLATFORM_CANDIDATE=/absolute/path/to/platform-candidate \
AGENT_MEMORY_SYSTEM_ROOT=/absolute/path/to/memory-system npm test
```

Ordinary `npm run build:session-app` resolves only public package exports. The build unifies React and React DOM resolution with the consumer to avoid a second renderer instance. Generated JS/CSS/fonts live under ignored `public/generated/`; a fresh deployment must build them before starting the server. Missing resources produce a visible load error.

`AGENT_MEMORY_SYSTEM_ROOT` is optional; without it the existing sibling memory-system path remains the default. Candidate server data, workspace, uploads and Codex state must be isolated. `scripts/testing/candidate-preview.mjs` provides synthetic Codex responses and local authentication for UI tests; it never proves real model or microphone behavior.

For interactive verification, run the same script with `--real`, an absolute isolated `CANDIDATE_PREVIEW_ROOT`, `AGENT_MEMORY_SYSTEM_ROOT` and `AGENT_PLATFORM_CANDIDATE`. It uses the installed Codex binary and a permission-restricted copy of the current user's `auth.json` (override with `AGENT_PREVIEW_AUTH_SOURCE`). Session history, configuration, uploads and product state stay in the preview root. Its local authentication helper is only for a loopback preview, not a deployable authentication service. Use `AGENT_PREVIEW_PORT` to retain a preview port when reloading an idle owned candidate. Synthetic native IDs are unique across preview restarts so saved fixtures do not collide. Stop the owning preview process to close its child server and helper. Shared recording scripts must be available in the preview's `workspace/shared-web` for microphone input.

Use the project-owned `scripts/testing/session-ui.flow.mjs` with `tools/workspace-playwright/pw record` to produce desktop/mobile videos and ordered frames. Browser regressions also cover lazy draft/restart recovery, runtime lease expiry and read-only child previews. Platform owns the shared component and input-state tests; Agent Web retains backend authorization, upload validation, thread, memory, integration and service safety tests.

`scripts/testing/session-draft.flow.mjs` records desktop/mobile draft creation under a delayed history request, actual default/configuration selection, reload recovery, empty-draft archive and archived-history discovery. It asserts that none of these actions creates a backend Session. App Server canaries separately verify that the selected profile reaches the first Turn in both supported kernels.

`scripts/testing/session-context.flow.mjs` submits one synthetic Turn, verifies that the App Server token notification reaches the Composer and checks the context dialog's same reported values. It opens Input Options on narrow screens, where the context control lives. The recording CLI's `--timeout` is in seconds.

`candidate-preview.mjs --recovery` seeds isolated, released desktop/mobile Sessions and synthetic native history. `session-recovery.flow.mjs` records recovery, execution across the former preview polling interval, continuous sends and reload during execution. `test/platform-session-recovery.test.js` separately delays a preview read until after promotion and verifies subscription cleanup, target persistence, profile application and message uniqueness.

Opening an older web attachment reconciles its Turn state against the latest native Turn, including terminal states. A later completed Turn clears an older attachment's interruption without starting a Turn or dispatching its old requirements. Recent uses the native Turn's activity time; resume, thread status and token usage notifications cannot move an idle conversation to the top. `test/session-resume-state.integration.test.js` covers this through the real server in both kernels. `candidate-preview.mjs --restore-state` and `session-resume-state.flow.mjs` record desktop/mobile reopening, switching, refresh and first real submission against synthetic older attachments.

Finish the selected package's build and full tests before recording browser flows: `pretest` rewrites `public/generated/`, so a simultaneous candidate build or recording can observe a different bundle during the same flow.

`scripts/testing/session-chrome.flow.mjs` verifies the fixed sidebar toggle, contiguous list/detail layout, and account dialog against an existing Session in the isolated real preview. It reads usage without submitting a model Turn and records both desktop and mobile results.

`scripts/testing/session-tools.flow.mjs` covers the three related tabs, real relation/voice metadata, direct realtime opening, close/reopen and simulated microphone denial. It never captures physical audio or starts a model Turn; this is separate from physical voice acceptance.

`scripts/testing/session-references.flow.mjs` records synthetic desktop drag/mobile `@` selection, removal, draft switching, submit and reference navigation. `session-references-real.flow.mjs` uses existing authorized real Sessions to verify drag/selection, resolution, refresh recovery and removal without a new model Turn. Native legacy/Platform input and public transcript persistence are verified separately in the isolated migration integration test.

## Removed duplicate implementation and rollback

Removed Session assets: `public/app.js`, `styles.css`, `thinking-session.css`, `agent-upload.js`, `agent-voice-input.js`, `agent-realtime.js`, and the old Codex-update widget assets. Product memory/integration dialogs, the local Markdown reader/editor, icons and service worker remain. Private DOM/stylesheet regex tests are retired or narrowed to their surviving backend contracts; UI behavior is covered by Platform and recorded application flows.

Rollback restores the last verified deployed Agent Web commit and its corresponding Platform pin, including the complete frontend and product gateways. Added receipt fields are backward-compatible metadata. Deployment must preserve unrelated local work and stored Session identities, build the generated assets, and use an external restart only when no Turn is running. The exact rollback commit, release and production readback belong in the owning Change.

## Session experience

Progress replies and viewed-image records show their content directly after opening the execution group. Commands and tools with parameters or output retain one disclosure; simple records do not add another click. Image records and attachments open the shared DocumentPreview.

Final answers render the exact `memoryCitation.entries` recorded by the Host as “本轮读取”. Core, Now and relevant topic files open the same authenticated preview. Historical answers without recorded citations do not acquire inferred sources. Memory injection remains the per-Turn Host policy.

The Host exposes `/api/platform/file-preview` descriptors and `/api/platform/file-resource` raw bytes behind authentication and a realpath workspace boundary. Markdown relative references resolve from their document directory. HTML renders only inside the shared sandbox; raw HTML is served as plain text. Unsupported formats and oversized text offer original-file download, and failed reads can retry.

A metadata-only SSE stream at `/api/platform/session-events` updates displayed catalogue rows while another Session is selected. It does not attach background Runtimes or read transcripts. Replay is process-local and bounded; reconnect, focus or replay gaps reconcile displayed catalogue metadata. Revisions and current Turn IDs reject old status updates. A changed server instance resets that revision domain. Hidden pages close the stream.

`candidate-preview.mjs --experience` provides isolated Core/Now, files, viewed-image records and two synthetic Turns for `session-experience.flow.mjs`. Record desktop/mobile with `pw record --timeout 120`; the flow covers in-page previews, relative image loading, failure retry, unsupported downloads, direct process content and B completing while A stays selected.
