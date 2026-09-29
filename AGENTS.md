# Agent Terminal Web

## Service safety

- Never stop or restart `agent-terminal-web.service` from an Agent Web Codex
  session. Finish verification and commits, then report that an external
  restart is required.
- Preserve unrelated work in the shared worktree. Stage and commit only the
  changes owned by the current task.

## Deployment

- Production runs as a user systemd service on the VPS. Its unit files and
  drop-ins are versioned in `~/workspace/server-config/systemd/user/`; install
  them with `./scripts/validate.sh` and `./scripts/install-user-units.sh`
  (which already reloads systemd). Do not edit `~/.config/systemd/user` alone.
- Update code with `git pull --ff-only` and `npm ci`. Restart with
  `systemctl --user restart agent-terminal-web.service` from a terminal
  outside Agent Web, and only when no Turn is running.

## Platform kernel switch

- `AGENT_PLATFORM_KERNEL` chooses the Session kernel: `new` puts new web
  Sessions on the Platform kernel, `all` puts every Session on it, and
  `legacy` forces every Session back to the old kernel, overriding the
  persisted `runtimeKernel`. Removing the variable is not a rollback: Sessions
  already marked `platform` keep using Platform.
- SSH hosts and `AGENT_SHARED_APP_SERVER=0` always use the old kernel. The
  persisted and reported `runtimeKernel` must be the kernel actually in use.

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
- Agent Web normally owns one on-demand, long-lived Codex App Server connection.
  Main Sessions, Side Chats, and catalog metadata calls use thread-scoped
  clients over that connection. Keep event and approval routing isolated by
  `threadId`, unsubscribe released threads, and never close the shared process
  when one Session detaches.
- `AGENT_SHARED_APP_SERVER=0` is a rollback-only path. In that legacy mode, the
  hidden Catalog App Server remains metadata-only, uses `mcp_servers={}`, and
  is reclaimed after an idle interval.
- When updating `@playwright/mcp`, regenerate
  `config/playwright-mcp-tools.json` with
  `npm run update:playwright-tools`, then verify that tool listing remains
  process-free.
