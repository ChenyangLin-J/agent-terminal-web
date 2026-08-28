# Platform SessionWorkspace Canary

This canary lets Agent Terminal evaluate the shared `@agent-workbench/platform` Session UI without replacing the current App Server or PTY interfaces.

## Enable and exit

- Open Agent Terminal with `?platformSession=1`. The flag is retained for the same origin while sessions are opened or refreshed.
- On desktop, click **退出新版** in the Session header to return to the current Agent Terminal UI.
- On mobile, open the same URL with `?platformSession=0` to disable it.
- The canary applies only to App Server sessions. PTY Terminal sessions keep their existing UI.

The server must be started from this revision so the authenticated `/api/local-file-preview` route is available. Do not restart `agent-terminal-web.service` from an Agent Web Codex session; use the normal deployment or service-owner path.

## Evaluation checklist

1. Open an existing App Server session and a new draft. Confirm restored messages, streaming commentary, final answers, run status and earlier-history loading.
2. While a turn is running, verify **追加当前** and **下一轮**. Stop the turn and answer both approval and `requestUserInput` cards.
3. Paste long rich text and attach image, Markdown, code and PDF files. Remove one attachment before sending and confirm only the remaining files are sent.
4. Open an image attachment and local Markdown/code links. Confirm the preview stays inside the Session, relative Markdown images and heading anchors work, line references are highlighted, and external/download actions still work. Edit a workspace Markdown file, confirm a normal save updates its version, then change it externally and verify the stale draft is rejected instead of overwriting the disk file.
5. Open **列表**, **Agents**, **侧问**, and the **工具** menu. These use the existing Agent Terminal product flows while the main Session surface is shared.
6. Repeat at desktop, iPad-width and 390px mobile widths. Confirm there is no horizontal page overflow and the composer remains reachable above the mobile navigation.

## Automated evidence

```bash
npm run build:session-ui
node --test \
  test/session-workspace-canary.test.js \
  test/session-switcher-actions.test.js \
  test/app-server-markdown.test.js \
  test/collaboration-features.test.js \
  test/mobile-history.test.js \
  test/new-session-link.test.js
node --test test/local-markdown.test.js
node --test --test-name-pattern='workspace links preserve|authenticated local-link' test/local-file-link.test.js
node --check public/app.js
node --check server.js
```

The full `npm test` suite currently also imports the sibling `../memory-system` repository. On a checkout without that repository, `codex-memories`, `personal-memory-context`, and server-spawning integration tests fail before exercising this revision.
