# Personal memory

The personal memory system is the primary, editable memory source for Agent Web. Codex's native memory generator remains enabled as a secondary observation source, but native memory injection is disabled after this system passes its integration checks.

## Files

- `~/.codex/personal-memories/store.json`: current confirmed and pending memory.
- `~/.codex/personal-memories/history.jsonl`: append-only create, update, approval, retirement, and deletion audit events.
- `~/.codex/personal-memories/worker-state.json`: per-thread watermarks, retry state, daily usage, alerts, and latest run status.

These files are private user data and are intentionally not committed to the repository.

## Read policy

Before every App Server turn, Agent Web injects all confirmed, non-sensitive global memories and only project memories selected by the current working directory or explicit project aliases in the prompt/title. Sensitive memories are injected only when the current topic is relevant. App Server uses `additionalContext`, so memory does not become visible user prompt text. Terminal sessions receive the same context once at session startup through `developer_instructions`.

The current user message always wins over stored memory. Answers show a citation for the exact memory entries injected into that turn.

## Write policy

`personal-memory-worker.timer` checks every ten minutes. A non-archived, user-created CLI or Agent Web thread becomes eligible after ten minutes of inactivity. The worker uses a transient `codex exec --ephemeral` extraction run and advances the thread watermark only after a successful result.

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
