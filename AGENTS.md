# Agent Terminal Web

## Service safety

- Never stop or restart `agent-terminal-web.service` from an Agent Web Codex
  session. Finish verification and commits, then report that an external
  restart is required.
- Preserve unrelated work in the shared worktree. Stage and commit only the
  changes owned by the current task.

## Shared MCP architecture

- A local MCP provider is a shared capability, not a per-Session process.
  Global Codex configuration must point local providers at Agent Web's
  loopback-only Streamable HTTP endpoints. Do not add heavyweight local STDIO
  `command` entries that Codex would copy into every App Server.
- Provider discovery must stay cheap: `initialize` and `tools/list` use a
  versioned manifest and must not start the provider. Start the backend only
  for an actual `tools/call`.
- Default to zero idle instances and one shared running instance. Stateless
  providers may multiplex calls; stateful providers such as Playwright must
  serialize calls.
- Do not give two browser processes the same persistent profile. A future
  overflow instance requires an explicit capacity decision, a separate
  profile/port, and a bounded `maxInstances`.
- Every provider needs an idle timeout, bounded errors, secret redaction where
  credentials exist, process-count tests, and a clear failure message.
- The hidden Catalog App Server is metadata-only. Keep `mcp_servers={}` on its
  launch and reclaim it after an idle interval.
- When updating `@playwright/mcp`, regenerate
  `config/playwright-mcp-tools.json` with
  `npm run update:playwright-tools`, then verify that tool listing remains
  process-free.
