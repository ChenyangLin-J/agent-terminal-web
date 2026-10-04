# Agent Web 部署验证证据

## 部署验证

状态：待执行。以下记录 Terminal 与远端主机功能移除版本的部署方案、验收要求和回读格式，不代表功能已经移除或部署已经通过。

编写日期：2026-10-04。编写时仓库代码基线为 `ecaf541`；该 checkout 仍保留 `/api/hosts` 路由。部署时需另行记录包含功能移除实现的目标 commit，不能把本方案的文档提交当作实现提交。

所有部署和回退命令均由 **VPS 的外部 SSH 终端或外部运维流程** 执行。不得在 Agent Web 内的 Codex Session 中停止或重启 `agent-terminal-web.service`；重启会断开当前及其他活动网页会话。

### ① 部署前：在 VPS 上留基线

先确认工作区没有需要保留的未提交改动；如有，先妥善保存，再部署，不覆盖或清理其他任务的文件。

```bash
cd ~/workspace/agent-terminal-web
git status --short
systemctl --user status agent-terminal-web.service --no-pager | head -5
git log --oneline -1
OLD_COMMIT=$(git rev-parse HEAD)
```

把部署前服务状态和 `OLD_COMMIT` 的完整值填入下面的回读记录。仓库 HEAD 是代码基线，不单独证明正在运行的服务使用该版本；如部署前有未重启的更新，须另行确认可用的回退版本。

### ② 部署：仅在外部终端执行

```bash
cd ~/workspace/agent-terminal-web
git pull --ff-only && npm ci && systemctl --user restart agent-terminal-web.service
```

仅在上一步全部成功后继续；拉取、依赖安装或重启失败时先排查，不按成功部署继续验收。

```bash
sleep 5
systemctl --user status agent-terminal-web.service --no-pager | head -5
git log --oneline -1
journalctl --user -u agent-terminal-web.service --since "2 minutes ago" -o cat | rg 'ws-|error|Error|listen|Terminal' | tail -20
journalctl --user -u agent-terminal-web.service --since "2 minutes ago" -o cat
```

保留目标 commit、服务状态和启动日志。过滤日志用于快速定位，完整日志用于检查过滤条件遗漏的异常。服务启动正常后再执行功能验证。

### ③ 功能验证清单

验收重点：已移除的入口不再出现，保留功能继续正常。所有项目初始状态均为待验证；旧 Terminal Session 不存在或某功能无法触发时，注明原因，不写成通过。

| # | 验证什么 | 怎么验 | 预期 |
|---|---|---|---|
| 1 | 服务启动 | 查看部署后的服务状态和启动日志，确认监听端口 | 服务正常运行，无启动错误，端口正常监听 |
| 2 | 登录与中控 | 手机或浏览器登录并打开中控 | 无主机标签栏，Session 列表正常 |
| 3 | 普通会话 | 打开一个已有 App Server Session | 无 Terminal/Text 标签、快捷键条和“专注”按钮；历史显示正常 |
| 4 | 发消息 | 发一条简单消息，等待完整一轮结束；分别检查命令输出及可触发的审批卡片 | Turn 正常完成，命令输出和审批卡片正常渲染；未触发审批时该子项注明待验证 |
| 5 | 旧 Terminal Session | 找一个以前以 Terminal 模式创建的 Session（如有），打开历史并继续发消息 | 按普通历史打开，能续跑；若没有可用样本，注明未验证及原因 |
| 6 | 追加与下一轮 | 运行中测试“追加当前”，完成后再追问并测试“下一轮” | 追加进入当前任务，下一轮独立处理，不丢消息、不串轮 |
| 7 | Side Chat 与子 Agent | 在会话中分别打开 Side Chat，并运行一次子 Agent | 面板与结果显示正常，消息归属正确 |
| 8 | 附件与语音 | 上传一张图，并进行一次语音输入 | 附件与转写正常上屏，消息可发送 |
| 9 | 分享与 Markdown | 打开一个分享链接，并打开一个本地 Markdown 文件 | 内容与 Markdown 渲染正常 |
| 10 | 记忆与集成 | 打开记忆入口和集成设置页 | 页面正常，无异常 |
| 11 | Codex 更新通知与异步提问 | 检查 10/03 新增的更新通知横幅；触发异步提问并回复 | 通知、问题和回复正常显示与处理；无可用通知或无法触发时注明待验证 |
| 12 | 后端与接口移除 | 完成功能操作后观察完整日志；在已通过鉴权的请求中访问 `/api/hosts` | 共享连接稳定，无 `app-server-stderr` 或 `exit` 异常刷屏；已移除接口返回 404 |

第 12 项可先记录本地探测状态：

```bash
curl -sS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:3030/api/hosts
journalctl --user -u agent-terminal-web.service --since "10 minutes ago" -o cat
```

若探测返回 401，只能证明鉴权拦截，不能证明接口已删除。此时在已登录浏览器中请求 `/api/hosts`，检查实际 HTTP 状态；也可使用已通过鉴权的本地请求验证。不要把登录跳转或未鉴权的 401 当作接口移除通过。

### ④ 出问题时的处理与回退

- 页面打不开或返回 500：先保留以下日志及发生时间，回读排查。
- 会话功能异常但服务仍运行：保留失败项目、复现步骤和对应日志；必要时由外部终端回退至部署前确认可用的 commit。
- 已确认移除的 Terminal 或远端接口返回 404 是预期行为；仍需保留的普通会话接口返回 404 不属于通过。

```bash
journalctl --user -u agent-terminal-web.service -n 50 -o cat
```

回退命令仅在外部终端执行，使用第 ① 步记录的完整 commit；若更换终端，先重新设置 `OLD_COMMIT`。确认工作区没有未保存改动后执行：

```bash
cd ~/workspace/agent-terminal-web
git checkout "$OLD_COMMIT" && npm ci && systemctl --user restart agent-terminal-web.service
```

全部成功后重新检查服务状态、启动日志和普通会话功能。该命令会进入 detached HEAD；恢复后续部署前应切回部署分支。

回退兼容性待目标实现核对：需确认没有不可逆的数据迁移，且持久化 favorites、Session 记录字段仍可由旧代码读取。不能仅因改动主要是删除代码，就断言“回退无数据风险”。部署与回退均不得删除这些持久化记录。

### ⑤ 回读与收口记录

必须回读：部署后启动日志，以及清单第 2、3、4、5 项的实际结果（截图或描述均可）。其余项目也要逐项记录；失败、未触发、无样本和待验证应分别注明。

| 记录项 | 实际结果 |
|---|---|
| 部署时间 | 待填写 |
| 部署前仓库 commit | 待填写 |
| 已确认可用的回退 commit | 待填写 |
| 目标实现 commit | 待填写 |
| 部署后服务状态与启动日志 | 待填写 |
| #1 服务启动 | 待验证 |
| #2 登录与中控 | 待验证；附截图或描述 |
| #3 普通会话 | 待验证；附截图或描述 |
| #4 发消息、命令输出与审批 | 待验证；附截图或描述，并注明审批是否触发 |
| #5 旧 Terminal Session | 待验证；附截图或描述，无样本则注明 |
| #6 追加与下一轮 | 待验证 |
| #7 Side Chat 与子 Agent | 待验证 |
| #8 附件与语音 | 待验证 |
| #9 分享与 Markdown | 待验证 |
| #10 记忆与集成 | 待验证 |
| #11 更新通知与异步提问 | 待验证 |
| #12 共享连接与 `/api/hosts` 状态 | 待验证；注明鉴权情况和 HTTP 状态 |
| 回退兼容性 | 待核对目标实现 |
| 异常与处理结果 | 待填写；无异常也需在实测后记录 |
| 收口结论 | 待实测结果回读后填写 |

逐项检查清单和兼容性记录后再写收口结论；仍有失败或待验证项目时保留其状态与原因，不宣称部署全部通过。
