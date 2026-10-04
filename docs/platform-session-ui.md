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
| `lib/session-operation-receipts.js` | Bounded durable operation receipts, hashes and public results |
| `lib/memory-system-library.js` | Product memory dependency location |

Platform owns common interaction and presentation, selection protection, snapshot/event recovery, retry identity, and UI state. Agent Web owns its server/API/WS protocol, Runtime choice, authentication, native thread identity, persistence, memory, integrations, local-file access, notification service and deployment. Product endpoints and recording/account services must not be embedded in Platform components.

Historical process details are read lazily through the authenticated product projection, including previews with no live Runtime. Reading a completed record never resumes a Codex thread. Editing a user message forwards its existing authorized attachments to the product's Edit/Fork validation.

Existing `server.js` remains the integration point for Runtime lifecycle and product services. New shared-UI routes and receipt logic are separate modules. A later backend refactor can extract lifecycle, transcript projection, approvals and persistence in independent steps while preserving those contracts; moving product scheduling or memory policy into Platform would blur this boundary.

## Build and candidate verification

The current stable dependency pin remains v0.32.0 until delivery approval. This candidate requires the local Platform candidate (version 0.33.0) because the stable package lacks `./session-host`:

```bash
AGENT_PLATFORM_CANDIDATE=/absolute/path/to/platform-candidate npm run build:session-app
AGENT_PLATFORM_CANDIDATE=/absolute/path/to/platform-candidate \
AGENT_MEMORY_SYSTEM_ROOT=/absolute/path/to/memory-system npm test
```

After adopting a published compatible Platform pin, ordinary `npm run build:session-app` resolves only public package exports. The build unifies React and React DOM resolution with the consumer to avoid a second renderer instance. Generated JS/CSS/fonts live under ignored `public/generated/`; a fresh deployment must build them before starting the server. Missing resources produce a visible load error.

`AGENT_MEMORY_SYSTEM_ROOT` is optional; without it the existing sibling memory-system path remains the default. Candidate server data, workspace, uploads and Codex state must be isolated. `scripts/testing/candidate-preview.mjs` provides synthetic Codex responses and local authentication for UI tests; it never proves real model or microphone behavior.

Use the project-owned `scripts/testing/session-ui.flow.mjs` with `tools/workspace-playwright/pw record` to produce desktop/mobile videos and ordered frames. Browser regressions also cover lazy draft/restart recovery, runtime lease expiry and read-only child previews. Platform owns the shared component and input-state tests; Agent Web retains backend authorization, upload validation, thread, memory, integration and service safety tests.

## Removed duplicate implementation and rollback

Removed Session assets: `public/app.js`, `styles.css`, `thinking-session.css`, `agent-upload.js`, `agent-voice-input.js`, `agent-realtime.js`, and the old Codex-update widget assets. Product memory/integration dialogs, the local Markdown reader/editor, icons and service worker remain. Private DOM/stylesheet regex tests are retired or narrowed to their surviving backend contracts; UI behavior is covered by Platform and recorded application flows.

Rollback uses the pre-change Agent Web commit `88221caca542641db2fbb010629b085c4c90194d` and its Platform v0.32.0 pin. Restore the complete prior frontend with that checkout; do not retain two selectable Session implementations. Added receipt fields are backward-compatible metadata. Build authorization does not include updating the stable pin, publishing a Platform tag, merging, or deploying/restarting the VPS service.
