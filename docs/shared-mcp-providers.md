# Shared on-demand MCP providers

Agent Web treats a local MCP provider as a server capability shared by all
Codex App Servers. Each App Server keeps its own lightweight MCP client
connection for request attribution, but it does not own a provider process.

## Request path

```text
Shared App Server
├─ Main thread A ─┐
├─ Main thread B ─┼─> loopback Streamable HTTP proxy ─> shared provider backend
└─ Side Chat      ┘

Catalog metadata calls use the same App Server connection and do not own a
separate provider or App Server process.
```

The loopback endpoints are:

- `/internal/mcp/amap`
- `/internal/mcp/playwright`

Direct non-loopback requests receive `404`.

## Lifecycle contract

`initialize` and `tools/list` are served from versioned tool manifests. They do
not start a child process. The first valid `tools/call` starts the backend, and
all Agent sessions reuse it.

The generic lifecycle lives in `lib/shared-mcp-provider.js`:

- zero provider processes while idle;
- a single start promise prevents duplicate concurrent launches;
- optional call serialization for stateful providers;
- idle teardown after the last call;
- bounded logs and user-facing failures.

Amap multiplexes calls through one shared process and stops after 60 seconds of
tool-call inactivity. Playwright serializes calls through one shared process
and stops after five minutes of tool-call inactivity.

Playwright starts Browser Hand-off through its canonical controller on the
first real browser tool call. The shared Chrome service has its own no-client
idle timeout, so closing the Playwright provider never stops a connected human
takeover session.

## Concurrency policy

One provider process is the default even when multiple Sessions call it at the
same time:

- stateless providers may handle calls concurrently;
- stateful providers queue calls;
- an overflow instance is an explicit provider-specific exception, not a
  per-Session default.

A second browser instance must use a separate CDP port and profile. Never let
two browser processes open the persistent shared profile.

## Adding a provider

1. Add a versioned tool manifest that can answer discovery without launching
   the provider.
2. Use `SharedOnDemandMcpBackend` and `createSharedMcpHttpProxy`.
3. Choose multiplexed or serialized calls and set an idle timeout.
4. Expose a loopback-only `/internal/mcp/<provider>` route.
5. Point global Codex configuration at that URL; do not add a local STDIO
   command.
6. Test that multiple client connections still create zero providers during
   discovery and one provider on concurrent calls.
7. Document credentials, state isolation, failure behavior, and any justified
   overflow limit.

## Playwright manifest updates

`@playwright/mcp` is pinned. After changing its version, run:

```bash
npm run update:playwright-tools
```

The generator starts a temporary MCP process only long enough to read its tool
schemas. It does not start Browser Hand-off. Review the manifest diff and run
the proxy tests before deployment.
