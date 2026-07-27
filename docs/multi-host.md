# Multi-host Agent Web

Agent Web can keep personal and company Codex Sessions on different execution
hosts while presenting them in one authenticated interface.

```text
Agent Web
├── personal -> local codex app-server
└── company  -> SSH stdio -> Mac codex app-server
```

The personal host is always present. Optional SSH hosts are loaded from:

```text
~/.config/agent-terminal-web/hosts.json
```

Set `AGENT_HOSTS_FILE` only when a different configuration path is required.
See [`config/agent-hosts.example.json`](../config/agent-hosts.example.json).

## Isolation

- Each host owns its Codex process, authentication, native Sessions, Skills,
  plugins, MCP servers, files, and shell.
- The SSH host uses the configured absolute Codex path. Agent Web does not
  depend on the remote login shell `PATH`.
- Agent Web never copies the remote Codex credential or Session files.
- Personal Markdown memory is injected only into the `personal` host.
- Remote completed answers are not written to the personal Session preview
  cache and do not trigger the personal memory worker.
- Agent Web persists only the metadata required to reconnect a web Session:
  host id, remote cwd, native thread id, title, permissions, and turn state.

Remote output still transits the personal Agent Web server while it is streamed
to the browser. This is transport isolation, not a claim that company content
never leaves the Mac.

## Transport

SSH starts the remote `codex app-server` over its default JSONL stdio
transport. Agent Web does not open a Codex TCP or WebSocket listener. The SSH
alias belongs in the server user's `~/.ssh/config`; Tailscale supplies the
private network path.

Agent Web uses non-interactive SSH with `BatchMode=yes`, a bounded connection
timeout, and keepalives. The SSH key must already be authorized on the Mac.

## Current remote-host boundaries

- App Server Sessions are supported; remote Terminal/TUI Sessions are not.
- Remote Agent Web uploads are disabled. Files should already exist in the Mac
  workspace.
- Personal memory controls are disabled inside a company Session.
- Remote project choices come from the host configuration. An empty list keeps
  the remote workspace root available.
- Local-file preview and historical JSONL process inspection are not yet
  mirrored from the Mac. Live App Server output, diffs, approvals, tests, and
  normal coding remain available.

## Operational checks

Before enabling a remote host:

1. Tailscale is connected on both machines.
2. The server can SSH to the configured alias without an interactive prompt.
3. The absolute Codex command returns a version through SSH.
4. The remote workspace is readable through SSH, including macOS TCC-protected
   directories.
5. Starting `codex app-server` over SSH completes the protocol initialization.
6. The Mac stays on AC power and does not sleep during unattended work.
