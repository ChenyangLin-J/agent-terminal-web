# Personal memory

The personal memory system is the primary, editable memory source for Agent Web. Codex's native memory generator remains enabled as a secondary observation source. The Agent Web systemd drop-in disables native memory injection immediately before the updated server starts, avoiding a deployment window with neither memory source active.

## Files

- `~/.codex/personal-memories/store.json`: current confirmed and pending memory.
- `~/.codex/personal-memories/history.jsonl`: append-only create, update, approval, retirement, and deletion audit events.
- `~/.codex/personal-memories/worker-state.json`: per-thread watermarks, retry state, daily usage, alerts, and latest run status.
- `~/.codex/agent-session-settings.json`: per-Codex-thread access and semantic memory-project routing state.

These files are private user data and are intentionally not committed to the repository.

## Read policy

Before every App Server turn, Agent Web injects all confirmed, non-sensitive global memories plus the current semantic project memories. Semantic projects are independent of the filesystem working directory: `workspace` is only a file scope and is never treated as a memory project. Automatic routing checks the current prompt for one or more project names or aliases, retains the previous projects for follow-ups such as “继续”, and otherwise falls back to a concrete project directory or the Session title. A new explicit project mention replaces the retained automatic selection. The memory panel can switch a Session to manual multi-select or global-only mode and later restore automatic routing. The choice persists across Agent Web restarts by Codex thread id.

Sensitive memories are injected only when the current topic is relevant. App Server uses `additionalContext`, so memory does not become visible user prompt text. Terminal sessions receive the same context once at session startup through `developer_instructions`; live per-turn routing and manual selection are available in App Server sessions.

The current user message always wins over stored memory. Answers show a citation for the exact memory entries injected into that turn.

## Write policy

`personal-memory-worker.timer` checks every ten minutes. A non-archived, user-created CLI or Agent Web thread becomes eligible after ten minutes of inactivity. The worker uses a transient `codex exec --ephemeral` extraction run and advances the thread watermark only after a successful result.

The worker reads the Session's persisted semantic project set. Manual selections are authoritative; automatic selections are a strong hint that the fresh user transcript must still support. Separate durable facts may be written to separate projects when a Session uses multiple projects.

- Explicit, high-confidence, non-sensitive, non-conflicting information is confirmed automatically.
- Sensitive, uncertain, conflicting, or project-ambiguous information remains pending.
- Explicit high-confidence refinements update an existing memory in place.
- Uncertain updates and retirement proposals remain pending and leave the confirmed original untouched until approved.
- Deleted or retired content is tombstoned to prevent immediate recreation.
- One-off tasks, reminders, deadlines, transient status, and assistant-only statements are not memory.

Failures retry with exponential backoff and do not discard unprocessed transcript data. The worker records usage but has no processing cap. Home receives a notification for pending review, repeated failure, or high daily extraction usage.

## Operations

```sh
# Seed watermarks without reprocessing the already imported history
node scripts/personal-memory-worker.mjs --initialize

# Inspect state
node scripts/personal-memory-worker.mjs --status

# Run one scan
node scripts/personal-memory-worker.mjs
```

The production unit uses the Node 24 binary because the worker reads Codex's SQLite state via `node:sqlite`.
