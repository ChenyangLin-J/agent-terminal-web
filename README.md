# Agent Terminal Web

手机优先的私有 Codex 网页入口。

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
- 新会话可选择 `Terminal（稳定）` 或 `App Server（试用）`；Terminal 默认不变。
- App Server 用结构化 turn 处理“追加当前”和“下一轮”，避免分开发的 prompt 互相替换或串轮。
- Prompt 使用网页原生 textarea，适合语音输入后再点按修改文本。
- Terminal 模式由 `node-pty` 启动 `codex` CLI；App Server 模式通过 JSON-RPC 启动或恢复 thread。
- Codex 使用 `--no-alt-screen` 启动，方便保留手机滚动输出。
- 浏览器断开后，后端 session 默认保留 1 小时，可从选择页重连。
- 可以启动新会话，也可以从网页上的 saved sessions 列表点选恢复旧会话。
- 默认工作区限制在当前 workspace 下。
- 顶部有 `Terminal` / `Text` tab；`Text` 会把终端 buffer 转成手机上容易选择的普通文本。
- Terminal 模式下，`Codex /status`、`/permissions` 等按钮会直接把对应 slash command 发给 Codex CLI。
- App Server 模式下，命令或文件操作需要确认时会显示允许一次、本次会话允许、拒绝三个快捷操作。

## Mobile Flow

1. Open the site.
2. Pick a live session to reconnect, or start a new session.
3. Pick a live session, saved Codex session, or start a new session.
4. Dictate or type into the prompt textarea.
5. Tap `Send`; while a task is active, use `追加当前` for the same task or `下一轮` for a separate task.
6. Switch to `Text` when mobile text selection is needed.

Detached live sessions are kept for 1 hour. Terminal sessions use tmux when enabled; App Server sessions persist their thread id and can reconnect after a service restart.

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

Private environment values live in:

```text
/home/ubuntu/.config/private-web.env
```

Auth service:

```text
http://127.0.0.1:3060/api/verify
https://auth.chenyanglin.com/login
```
