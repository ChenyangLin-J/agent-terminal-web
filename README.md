# Agent Terminal Web

手机优先的私有 Codex 网页入口。

## Run

```bash
npm install
npm run build:session-app
npm start
```

The shared Session UI candidate and local Platform build instructions are in
[`docs/platform-session-ui.md`](docs/platform-session-ui.md). Build the browser
assets before starting a fresh checkout.

打开：

```text
http://127.0.0.1:3030
```

Production route:

```text
https://agent.chenyanglin.com
```

The production route is reverse proxied by Caddy. Authentication is delegated to Private Auth Web.

## What It Does

- 手机优先：打开后先进入登录和 session 选择页。
- 新会话使用 `App Server`，默认“全部允许”权限，也可选择“按需确认”。
- App Server 用结构化 turn 处理“追加当前”和“下一轮”，避免分开发的 prompt 互相替换或串轮。
- Prompt 使用网页原生 textarea，适合语音输入后再点按修改文本。
- App Server 模式通过 JSON-RPC 启动或恢复 thread。
- 浏览器断开后，后端 session 默认保留 1 小时，可从选择页重连。
- 可以启动新会话，也可以从网页上的 saved sessions 列表点选恢复旧会话。
- 默认工作区限制在当前 workspace 下。
- 回答中的 workspace Markdown 文件可直接在手机阅读页中打开、编辑并安全保存；文件已被其他程序更新时不会静默覆盖。
- App Server 模式下，命令或文件操作需要确认时会显示允许一次、本次会话允许、拒绝三个快捷操作。
- Start 页和 App Server 会话工具栏提供“记忆”入口；也可输入 `/memories`。

## Home gateway

Home can read and continue these conversations through a token-protected direct
loopback adapter. Configuration, thread identity, retries, and pagination are
documented in [`docs/home-agent-gateway.md`](docs/home-agent-gateway.md).

## Memory

Agent Web 使用轻量的本地 Markdown 记忆与审核层；不使用向量数据库或知识图谱。入口包含三个视图：

后台会读取 Codex 当前及近期归档会话的用户消息和最终答复；兼容旧版事件格式与新版消息格式。会话完成后检查是否有值得跨 Session 保留的信息，符合低风险规则的个人记忆自动写入，其余候选进入审核。

- `个人记忆`：按 Markdown 文档展示 Obsidian 中的 Core、Now 与 Topics。
- `项目规则`：直接展示 workspace 一级项目目录中现有的 `AGENTS.md`。
- `变更记录`：少量待确认候选置顶，自动应用与已处理记录接在后面；每条显示北京时间的提出、写入或处理时间，以及修改前后内容和来源证据。Codex 原生记忆的已检查记录不代表正式记忆被修改。

App Server 的回答如果携带原生 `memoryCitation`，会在回答下显示“参考了 N 条记忆”，可展开查看来源与行号。

原生记忆文件保存在：

```text
~/.codex/memories/
```

可阅读和编辑的个人记忆保存在：

```text
obsidian/MainVault/System/Memory/
```

后台会自动写入明确、高置信、非敏感且无冲突的个人记忆；其余个人记忆以及所有项目规则、Skill 候选仍需确认。所有变更都进入审计记录并可在安全时撤回。结构化证据、处理水位和审计状态保存在 `~/.codex/` 下的私有运行文件中。

Memories 目前仍是实验功能。自动记忆适合召回背景与经验；必须执行的工程规则继续写在 `AGENTS.md`、Skill 或项目文档中。任务、截止时间和主动提醒继续由 Home 管理，不作为长期事实混进记忆。

## Mobile Flow

1. Open the site.
2. Pick a current session, saved Codex session, or start a new session.
3. Dictate or type into the prompt textarea.
4. Tap `Send`; while a task is active, use `追加当前` for the same task or `下一轮` for a separate task.
5. Switch to `Text` when mobile text selection is needed.

Detached App Server runtimes are kept for 30 minutes. The deadline survives
service restarts, and reconnecting only to restore the page does not extend it;
meaningful user input starts a fresh retention window. After the deadline,
Agent Web releases the runtime but keeps the Session under `当前 Session` as
`已暂停`. Runtime release never moves a Session into history. The user-facing
organization is explicit:

- `结束` stops the runtime, removes the Session from `当前 Session`, opens a
  new Session draft in the current page, and keeps the old thread under
  `最近历史`.
- `归档` stops the runtime and moves the Session to `已归档 Session`.
- `编辑` creates a replacement branch, switches the current page to it, and
  archives the source Session only after the edited prompt is submitted
  successfully. `分支` keeps both Sessions visible.
- Restoring a paused or historical Session keeps the Codex thread context.

The control center also keeps execution and reading state separate. `新结果`
means the latest completed turn has not yet been viewed; opening the Session
and reaching its latest transcript persists that turn as viewed. `空闲` means
the latest result was viewed and no task currently needs work. Session times
advance only for thread-scoped work, not for shared App Server account or rate
limit notifications.

Terminal sessions use tmux when enabled; App Server sessions persist their
thread id and can reconnect after a service restart.

## Resume

启动前在 `Launch` 里选择：

- `New session`: 运行 `codex`
- `/?new=1&cwd=.`: 从 workspace 直接创建新会话，供 Home 等快捷入口使用
- `/?new=1&cwd=.&transport=app-server`: 创建 App Server 试用会话
- `Resume last`: 运行 `codex resume --last`

如果知道 session ID，把 ID 填到 `Session ID`，会运行：

```bash
codex resume <SESSION_ID>
```

手机上不再需要使用 Codex CLI 的 resume picker；网页会列出 `~/.codex/sessions` 里的最近会话，点 `Resume` 即可。

Saved session titles can be renamed in the web UI. Custom titles are stored outside the repo:

```text
~/.codex/session-titles.json
```

Saved sessions can also be archived from the web UI. The web UI keeps a small archive record here:

```text
~/.codex/session-archive.json
```

Archive also calls Codex's native `codex archive <session-id>` when possible, so archived sessions are moved out of the normal Codex sessions directory. The web UI scans both `~/.codex/sessions` and `~/.codex/archived_sessions`, so archived sessions can still be restored.

Douyin and Xiaohongshu extraction Sessions archive automatically after a completed
turn has had no follow-up conversation for two hours. A dedicated Session is
identified from its first prompt: a media link/share, an extraction request, or
the `douyin-transcript` / `xiaohongshu-transcript` skill. Favorites and Sessions
with active or interrupted work remain available. A follow-up clears the
deadline; its successful completion starts a new two-hour window. Reading the
result or reopening the page does not reset the window.

Auto-archive timing is stored privately in
`~/.codex/agent-session-auto-archive.json`, so it survives runtime reclamation and
service restarts. Existing local extraction Sessions with a recorded completion
are also eligible. Before archiving, Agent Web verifies the latest native turn
is still that completed turn; failed archive requests are retried. The check runs
every minute and preserves the full conversation for later restoration.
`AGENT_MEDIA_SESSION_AUTO_ARCHIVE_IDLE_MS` and
`AGENT_MEDIA_SESSION_AUTO_ARCHIVE_CHECK_MS` override the two-hour window and
one-minute check interval for isolated tests or custom deployments.

The terminal helper uses the same title file:

```bash
codex-resume
codex-resume --rename
codex-resume --archived
codex-resume --unarchive
```

`codex-resume` lists numbered active sessions with title, project, and update time, then runs `codex resume <session-id>` internally after selection. It does not show the session id in the list. Archived sessions are hidden unless `--archived` or `--unarchive` is used.

The shell command is installed as a symlink, so edits to the project script take effect immediately:

```text
/usr/local/bin/codex-resume -> /home/ubuntu/workspace/agent-terminal-web/scripts/codex-resume
```

## Notes

- 默认只监听 `127.0.0.1`，不要直接暴露公网。
- Terminal 模式优先保留 Codex CLI 手感；App Server 模式只呈现当前工作流所需的结构化事件。
- 如需改端口：

```bash
PORT=3031 npm start
```

## Service

The local service is managed by user-level systemd:

```bash
systemctl --user status agent-terminal-web.service
systemctl --user restart agent-terminal-web.service
```

Codex processes launched from Agent Web cannot stop or restart this service themselves. They finish verification, commit, and report that an external restart is required, so one Session cannot interrupt every other active Session. If the service or an App Server process still exits during a turn, the restored conversation marks that turn as interrupted and offers a `继续完成` action.

App Server sessions show a separate task state (`连接中`, `空闲`, `处理中`, `终止中`, or `已中断`). `终止当前` interrupts only the active turn; it keeps the Session available for the next prompt and does not publish the partial response as a completed result.

WebSocket diagnostics are split across the Agent and proxy journals. Agent events distinguish
`ws-upgrade-received`, `ws-upgrade-complete`, authentication or parameter rejection,
attachment, browser-side handshake failure, and established connection closure. Caddy access
logs provide the HTTP status and proxy duration; their Agent-site formatter removes query
strings, public share tokens, authentication headers, cookies, and client IP fields.

```bash
journalctl --user -u agent-terminal-web.service --since "10 minutes ago" -o cat | rg 'ws-|client-event'
journalctl -u caddy.service --since "10 minutes ago" -o cat | rg 'agent.chenyanglin.com|http.log.access'
```

Private environment values live in:

```text
/home/ubuntu/.config/private-web.env
```

## External integrations and shared MCP providers

The authenticated Agent home includes an `集成` manager for external tool credentials.
Credentials are write-only in the browser: a configured value can be replaced or deleted,
but it is never returned to the page.

The manager includes Amap, Cubox, and TikHub, plus user-created entries containing only a
name and Key. Custom entries are storage-only: Agent Web does not validate, call, or inject
them into every Session. The project that needs one decides how to use it. TikHub is stored
without making a validation request, so adding the key cannot consume API credit; the
approved research run validates it on first use.

Integration credentials are stored outside the repository:

```text
/home/ubuntu/.config/agent-terminal-web/integrations
```

The directory is mode `0700` and each credential file is mode `0600`. Codex does not
receive the integration key in its parent environment. Agent Web exposes local providers
to Codex App Servers through loopback-only Streamable HTTP MCP endpoints:

Custom entries use a stable file contract under
`~/.config/agent-terminal-web/integrations/custom/<id>.json`:

```json
{
  "kind": "custom",
  "id": "00000000-0000-4000-8000-000000000000",
  "name": "Jina Reader",
  "key": "write-only-secret",
  "updatedAt": "ISO-8601 timestamp"
}
```

A project running as the same Linux user may scan those private files and match `name`.
There is deliberately no browser API for reading the Key and no per-project credential
isolation; a project must read only the credential it was explicitly configured to use.

```toml
[mcp_servers.amap]
url = "http://127.0.0.1:3030/internal/mcp/amap"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.playwright]
url = "http://127.0.0.1:3030/internal/mcp/playwright"
enabled = true
startup_timeout_sec = 10
tool_timeout_sec = 120
```

Connecting or listing tools does not start the Amap provider. The first Amap tool call
starts one provider shared by all Agent sessions, and it exits after 60 seconds without
another call. Replacing or deleting the credential closes the shared provider immediately.
Provider results and errors are recursively redacted before they return to Codex.

Cubox uses the same write-only browser flow but writes the verified domestic API link into
Cubox CLI's native config at `~/.config/cubox-cli/config.json` (directory `0700`, file
`0600`). The API link is validated only against the fixed `cubox.pro` CLI endpoint, is
never returned to the browser, and becomes available to `cubox-cli` on its next call.

Playwright follows the same shared lifecycle. Tool discovery uses a versioned manifest;
the first actual browser call starts Browser Hand-off and one Playwright provider shared
by all Agent sessions. Browser calls are serialized because they mutate one shared browser
state. The provider exits after five minutes without a tool call, while Browser Hand-off
uses its own no-client idle policy so an active human takeover is preserved.

Agent Web initializes one App Server connection on demand. Main Sessions, Side
Chats, and native thread catalog operations reuse that process while keeping turn state,
events, and approvals isolated by `threadId`. See
[`docs/shared-mcp-providers.md`](docs/shared-mcp-providers.md) for the lifecycle and the
required checklist for future local MCP providers.

Auth service:

```text
http://127.0.0.1:3060/api/verify
https://auth.chenyanglin.com/login
```
