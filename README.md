# Agent Terminal Web

最小版 Codex CLI 网页终端。

## Run

```bash
npm install
npm start
```

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
- 主界面只保留真实 Terminal，避免在手机上来回切换 Progress 和 Terminal。
- Prompt 使用网页原生 textarea，适合语音输入后再点按修改文本。
- 后端用 `node-pty` 启动 `codex` CLI。
- Codex 使用 `--no-alt-screen` 启动，方便保留手机滚动输出。
- 浏览器断开后，后端 session 默认保留 1 小时，可从选择页重连。
- 可以启动新会话，也可以从网页上的 saved sessions 列表点选恢复旧会话。
- 默认工作区限制在当前 workspace 下。
- 顶部有 `Terminal` / `Text` tab；`Text` 会把终端 buffer 转成手机上容易选择的普通文本。
- `Codex /status`、`/permissions` 等按钮会直接把对应 slash command 发给 Codex CLI。

## Mobile Flow

1. Open the site.
2. Pick a live session to reconnect, or start a new session.
3. Pick a live session, saved Codex session, or start a new session.
4. Dictate or type into the prompt textarea.
5. Tap `Send` and watch the Terminal.
6. Switch to `Text` when mobile text selection is needed.

Detached live sessions are kept in memory by the Node process for 1 hour. Restarting the service clears live web attachments, but Codex's own saved sessions can still be resumed from the `Saved Codex Sessions` list.

## Resume

启动前在 `Launch` 里选择：

- `New session`: 运行 `codex`
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

The terminal helper uses the same title file:

```bash
codex-resume
codex-resume --rename
```

`codex-resume` lists numbered sessions with title, project, and update time, then runs `codex resume <session-id>` internally after selection. It does not show the session id in the list.

## Notes

- 默认只监听 `127.0.0.1`，不要直接暴露公网。
- 这个版本优先复现 Codex CLI 手感，不做结构化 agent timeline。
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

Private environment values live in:

```text
/home/ubuntu/.config/private-web.env
```

Auth service:

```text
http://127.0.0.1:3060/api/verify
https://auth.chenyanglin.com/login
```
