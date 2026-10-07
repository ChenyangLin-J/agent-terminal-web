# Personal memory

The personal memory system is the primary, editable memory source for Agent Web. Codex's native memory generator remains enabled as a secondary observation source. The Agent Web systemd drop-in disables native memory injection immediately before the updated server starts, avoiding a deployment window with neither memory source active.

## Files

- `obsidian/MainVault/System/Memory/Core.md`: stable core memory loaded by default.
- `obsidian/MainVault/System/Memory/Now.md`: current cross-Session focus loaded by default.
- `obsidian/MainVault/System/Memory/Topics/*.md`: optional topic documents loaded only when relevant.
- `~/.codex/personal-memories/store.json`: current confirmed and pending memory.
- `~/.codex/personal-memories/history.jsonl`: append-only create, update, approval, retirement, and deletion audit events.
- `~/.codex/personal-memories/worker-state.json`: per-thread watermarks, retry state, daily usage, alerts, and latest run status.
- `~/.codex/memory-system/session-extractions.jsonl`: private, append-only Session extraction diagnostics, including runs that emitted no candidates.
- `~/.codex/agent-session-settings.json`: per-Codex-thread access and semantic memory-project routing state.

These files are private user data and are intentionally not committed to the repository.

## Read policy

Before every App Server turn, Agent Web injects all confirmed, non-sensitive global memories plus the current semantic project memories. Semantic projects are independent of the filesystem working directory: `workspace` is only a file scope and is never treated as a memory project. Automatic routing checks the current prompt for one or more project names or aliases, retains the previous projects for follow-ups such as “继续”, and otherwise falls back to a concrete project directory or the Session title. A new explicit project mention replaces the retained automatic selection. The memory panel can switch a Session to manual multi-select or global-only mode and later restore automatic routing. The choice persists across Agent Web restarts by Codex thread id.

Sensitive memories are injected only when the current topic is relevant. App Server uses `additionalContext`, so memory does not become visible user prompt text. Terminal sessions receive the same context once at session startup through `developer_instructions`; live per-turn routing and manual selection are available in App Server sessions.

The current user message always wins over stored memory. Final answers show “本轮读取” buttons for the exact memory entries recorded in that Turn’s `memoryCitation`, including Core, Now and any relevant topic documents. The shared in-page preview opens these files through the authenticated workspace boundary. Historical answers with no recorded citation show no inferred sources. This presentation does not change per-Turn `additionalContext` injection or the memory routing policy.

## Write policy

After an Agent Web Turn completes, the server schedules a memory check after a one-minute write-settling buffer. A non-archived, user-created thread is eligible only when the latest fresh user message has a later final answer; keeping the Session process open does not block extraction. Incomplete Turns never advance the thread watermark. `personal-memory-worker.timer` still scans every ten minutes as a fallback. The worker uses a transient `codex exec --ephemeral` extraction run and advances the thread watermark only after a successful result.

The UI distinguishes checks from model extraction runs. A check may scan every eligible thread but process zero when all watermarks are current, the newest Turn is incomplete, or a completed Turn is still inside the one-minute settling buffer; the daily token figure is cumulative across earlier extraction runs.

Every Session extraction returns a structured review, including when all candidate arrays are empty. Meaningful skipped facts include an exact user quote and a reason: already covered, covered by a pending proposal, transient, unsupported, or not personal context. A zero-candidate review must classify at least one fresh user message; a generic rationale with no source evidence is not sufficient. Coverage claims must reference an existing confirmed memory or pending change. The worker validates those references and both skipped-fact and proposal quotes against user messages before applying candidates or advancing the watermark. The review is the model's explanation of its selection, not proof of its internal reasoning.

Diagnostics record the input watermark range, message counts, prompt hash and length, model review, emitted candidate counts, and application results such as duplicates or tombstones. They do not copy the whole prompt or transcript. Each thread's runtime state also keeps the latest extraction summary. Missing or invalid reviews fail the extraction and retain the earlier watermark for retry.

Personal proposals must use global scope, reference a confirmed target for updates or retirements, and reference a matching pending personal change for merges. Invalid or unprocessed personal candidates fail the run instead of being silently filtered before the watermark advances. Exact duplicates and tombstoned entries remain valid terminal outcomes.

After the model returns, the worker rereads confirmed memory and pending proposals and compares their fingerprint with the prompt's snapshot. Changes trigger a retry with fresh context. Updates and retirements also compare their expected target under the store's write lock to protect concurrent user edits and deletions from an old extraction. This is an optimistic check rather than a transaction across Markdown, the ledger, and runtime state; direct Obsidian filesystem edits do not acquire that lock.

The worker reads the Session's persisted semantic project set. Manual selections are authoritative; automatic selections are a strong hint that the fresh user transcript must still support. Separate durable facts may be written to separate projects when a Session uses multiple projects.

- Explicit, high-confidence, non-sensitive, non-conflicting personal-memory additions and updates are applied automatically and remain visible in the audit feed with revert support.
- Sensitive, uncertain, conflicting, or weakly inferred personal memories remain pending. Retirement proposals also remain pending because they remove established context.
- Direct Obsidian edits and changes explicitly requested by the user are user actions rather than automatic extraction; they may be applied immediately and remain audited.
- A concrete ongoing reading or practice activity may enter `Now.md` when the user describes progress and plans to continue, even if this is its first Session. Preserve its subject and actual progress; a broad existing goal such as improving communication does not cover a specific book or exercise. A one-off lookup, assistant recommendation, or isolated completion does not establish ongoing focus. A request to save a practice record for tomorrow can establish continuation without becoming a permanent communication preference.
- Pending update and retirement proposals leave the confirmed original untouched until approved.
- Project-rule and Skill candidates always remain pending.
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
