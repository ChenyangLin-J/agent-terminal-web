# Agent Web 部署验证证据

## 部署验证

状态：用户已在依赖安装后再次外部重启并完成共享浏览器登录，生产主要功能已实测。Side Chat 暴露了 Codex RPC 参数冲突，代码已修复，完整测试 203/203 通过；修复尚未由运行进程加载，须在本轮结束后外部重启并复验 Side Chat。旧 Terminal 会话及实际更新通知横幅缺少样本，保持未验证。自动测试结果与生产实测分别记录，不宣称已全部收口。

编写日期：2026-10-04。目标实现 commit 为 `310d2c21977853df32e9ce012b1d4d57a225791f`（`310d2c2`），即 GitHub `main` 已合入的 PR #8：移除 Terminal/PTY、multi-host、orchestration 与 focus mode。部署时记录实际部署 commit，并确认其包含此目标实现；本方案的文档提交不等于实现已经部署。

所有部署和回退命令均由 **VPS 的外部 SSH 终端或外部运维流程** 执行。不得在 Agent Web 内的 Codex Session 中停止或重启 `agent-terminal-web.service`；重启会断开当前及其他活动网页会话。

外部重启前须确认没有 Turn 正在运行，再完成依赖安装与重启。

### ① 部署前：在 VPS 上留基线

先确认工作区没有需要保留的未提交改动；如有，先妥善保存，再部署，不覆盖或清理其他任务的文件。若本地与远端分支已分叉，`git pull --ff-only` 会失败；须先审查并整合需要保留的本地提交，不通过强制重置绕过，也不在整合完成前继续部署。

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
| 7 | Side Chat / 子 Agent | 在会话中打开一次 Side Chat 或子 Agent 面板 | 面板与结果显示正常，消息归属正确；注明实际覆盖的功能 |
| 8 | 附件 / 语音 | 上传一张图或进行一次语音输入 | 附件或转写正常上屏，消息可发送；注明实际覆盖的功能 |
| 9 | 分享 / Markdown | 打开一个分享链接或本地 Markdown 文件 | 内容与 Markdown 渲染正常；注明实际覆盖的功能 |
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

App Server 仍使用 `/terminal` 作为 WebSocket 路径。此路径名称兼容保留，不属于应返回 404 的已移除接口。

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
| 部署时间 | 用户首次外部重启于 2026-10-04 14:22:43 CST；补安装依赖后再次重启于 14:45:34 CST，随后完成共享浏览器登录。本次已登录实测约 14:46—15:02 CST |
| 部署前仓库 commit | 重启前仓库已整合为 `4e34dc4efabfa2fecf2fa4bb8ba367f7a4f91945`；整合前本地 HEAD 为 `86ed211`。更早运行进程的实际加载版本未确认 |
| 已确认可用的回退 commit | 未确认；不能把整合前仓库 HEAD 直接认定为经过生产验证的回退版本 |
| 目标实现 commit | `310d2c21977853df32e9ce012b1d4d57a225791f`（PR #8 merge） |
| 实际部署 commit 及包含目标实现的确认 | 14:45 重启时仓库为 `0fe802a`，实现为 `4e34dc4`，本地与 GitHub `main` 一致；`git merge-base --is-ancestor 310d2c2 HEAD` 成功，包含目标实现和本地修复。运行进程尚未包含本轮 Side Chat 参数修复 |
| 部署后服务状态与启动日志 | active/running，PID 92625，启动于 14:45:34 CST，`NRestarts=0`；监听 127.0.0.1:3030；启动日志见下文 |
| #1 服务启动 | 通过：依赖安装后的新进程监听正常，`/healthz` 200、正文 `ok`，无启动失败 |
| #2 登录与中控 | 通过：用户完成共享浏览器登录后，桌面和 390×844 手机视口均显示中控与 Session 列表；无主机标签栏。截图已直接查看 |
| #3 普通会话 | 通过：打开部署前已有 App Server 会话 `01a1050b-5466-7a02-93a3-d817a52e03f7`，历史、执行记录和输入区正常；无 Terminal/Text 标签、快捷键条或“专注”入口。后台在本次重启后恢复了 7 轮历史，手机页面已直接查看 |
| #4 发消息、命令输出与审批 | 通过：独立合成验收会话 `01a105ac-3804-7cc1-8e20-7c56f9fc2edc` 执行立即结束的 Python 打印命令，真实审批卡片显示并允许一次，退出码 0，输出区显示 `DEPLOY_OUTPUT_OK`，模型完成 `ROUND3_DONE`。重载后续跑返回 `RESUME_OK` |
| #5 旧 Terminal Session | 未找到可确认的生产样本：初次样本检查的 28 条持久化记录，`transport` 均为 `app-server`，无显式 Terminal 标记；不能据此排除历史上以 Terminal 创建的记录。生产迁移续跑未验证，模拟记录的代码测试通过，见整合验证 |
| #6 追加与下一轮 | 通过：运行中“追加当前”加入第一轮，最终包含 `APPEND_1`；“下一轮”等待第一轮结束后独立回复 `ROUND2_DONE`。DOM 中第一轮与追加共用 turnId `01a105ac-3944-7fe3-92f4-007dfdfeed37`，下一轮使用 `01a105ad-62ac-73c2-bb95-632a2e81bd58`。长命令仅用于制造运行窗口，完整命令退出证据采用第 4 项的短命令 |
| #7 Side Chat / 子 Agent | 子 Agent 面板通过：本轮 explorer 与 worker 均显示“已完成”，旧子 Agent 卡片仍保留。Side Chat 面板能打开，但发送失败：`deferGoalContinuation` cannot be combined with `ephemeral`。已修复参数冲突并通过集成测试，生产复验待外部重启，不能把 Side Chat 写为通过 |
| #8 附件 / 语音 | 通过图片路径：上传仓库终端图标 `icon-192.png`，预览与消息附件均上屏，模型正确描述白色箭头和渐变小点；重载后附件仍在。语音输入未单独实测 |
| #9 分享 / Markdown | 通过 Markdown 路径：已登录打开本地 `evidence.md`，页面标题与正文正确，表格与代码块正常渲染，截图已直接查看。未另行创建或打开分享链接 |
| #10 记忆与集成 | 通过：记忆面板正常加载 Core/Now 与项目规则入口；集成页正常显示新增 Key 表单和已配置状态。仅查看页面，未修改记忆、凭证或设置 |
| #11 更新通知与异步提问 | 异步提问通过：真实选择卡片显示 `DEPLOY_A` / `DEPLOY_B`，提交后标记“已回答”，模型在后续一轮回复 `ASYNC_OK DEPLOY_A`，手机页面正常。更新入口和空态通过：已鉴权 `/api/codex-updates` 200，当前 `items` 为空，页面显示“暂时没有更新记录”；实际版本通知横幅缺少样本，未验证 |
| #12 共享连接与 `/api/hosts` 状态 | 通过连接及接口检查：已登录浏览器请求 `/api/hosts` 404，`/api/projects` 200；新增验收会话、子 Agent、失败的 Side Chat、重载和归档后仍只有一个共享 App Server（包装进程 92673、实际进程 92681）。本次重启后的结构化日志无 `app-server-stderr` / exit / error 刷屏；Side Chat 的 RPC 错误已在第 7 项单独记录。已移除静态资源仍为 404 |
| 回退兼容性 | 代码测试覆盖旧 Terminal 持久化记录恢复续跑、收藏保护及旧远端归档记录保留；生产回退未演练，不能断言完全无数据风险 |
| 异常与处理结果 | 旧磁盘依赖已通过 `npm ci` 补齐，并由用户在 14:45 外部重启后加载。共享 Playwright MCP 初始化超时后改用同一 Chrome 的 CDP，保留 profile 与其他标签页。按需确认模式下测试命令因沙箱启动失败请求真实审批，允许一次后短命令成功。Side Chat 参数冲突已修复并通过 203 项完整测试，尚待生产部署复验 |
| 收口结论 | 主要保留功能已通过实测，验收仍未完整收口。须外部重启部署 Side Chat 修复，再复验第 7 项；第 5 项及第 11 项的实际通知横幅继续注明无样本、未验证 |

逐项检查清单和兼容性记录后再写收口结论；仍有失败或待验证项目时保留其状态与原因，不宣称部署全部通过。

生产启动日志（2026-10-04 14:45:35 CST）：

```text
Agent Terminal Web: http://127.0.0.1:3030
Workspace root: /home/ubuntu/workspace
Detached session TTL: 30 minutes
```

首次重启后的依赖检查因版本不符报 `ELSPROBLEMS`。补安装后，`npm ls markdown-it hono fast-uri ip-address qs --all` 成功：markdown-it 14.3.2、hono 4.13.8、fast-uri 3.1.8、ip-address 10.7.2、qs 6.16.0。用户随后在 14:45:34 完成外部重启，新的 Node 进程启动晚于安装，依赖部署缺口已解决。本 Session 没有重启或终止生产服务。

首次启动后的 14:24:26 曾有一条诊断 shell 命令被执行平台拒绝的 stderr，已通过只读替代命令完成检查；它不属于服务崩溃。本次 14:45:34 重启后的日志未观察到 App Server stderr 或退出刷屏。Side Chat 的 RPC 失败已单独实测和修复，不以日志安静掩盖功能失败。

共享浏览器保留原有 profile 和其他标签页，仅使用本任务验证页；用户通过 Browser Hand-off 自行登录。没有绕过鉴权、输出 cookie/token/密码或修改集成凭证。独立合成验收会话完成后已归档（HTTP 200），历史保留，未归档或修改其他会话。

[生产验收截图与测试日志](https://home.chenyanglin.com/preview/agent-deploy-evidence-20261004-2/) 通过私有 Home 鉴权访问，包含真实审批、图片与异步提问、手机回答、Side Chat 失败及子 Agent 面板截图，以及 203 项自动测试日志；预览默认保留 7 天。截图已直接查看，预览页面及图片加载已验证。

### Side Chat 修复验证

生产 RPC 拒绝把 `ephemeral: true` 与 `deferGoalContinuation: true` 同时用于 Side Chat 的 `thread/fork`。仅移除 Side Chat fork 的 `deferGoalContinuation`，继续保留只读、临时分支及线程隔离；主 Session 和普通分支的该设置保持不变。

新增 `test/side-chat.integration.test.js`，在模拟 App Server 的 RPC 边界拒绝不兼容组合，验证修复后可创建只读临时分支、提交侧问并在该线程收到回答。

| 验证 | 实际结果 |
|---|---|
| Side Chat、协作功能与共享连接定向测试 | 5/5 通过 |
| `npm test -- --test-concurrency=2` | 203/203 通过，0 失败、0 跳过 |
| `git diff --check` | 通过 |
| 生产修复复验 | 待外部重启；当前 PID 92625 仍运行修复前代码，不将自动测试替代生产通过 |

## 整合验证

验证日期：2026-10-04。整合父版本为本地 `86ed211` 与远端 `310d2c2`；采用 merge 保留双方历史。远端的 Terminal/PTY、多主机、自动编排与 focus mode 删减及依赖升级均保留，本地自动归档、旧运行状态修正、记忆提取修复和部署方案均保留。

自动归档已改用共享 App Server。持久化的 personal host 标识继续兼容；旧远端主机的归档记录保留，但不会派发到本地执行。归档期间收到追问时，先取消归档并恢复原线程，再提交追问。

手动归档、自动归档和恢复会话统一通过同步原子读改写入口更新归档侧录，使用唯一临时文件名。并发归档与取消归档的回归测试确认无 500、无旧快照覆盖、无其他线程记录丢失。

所有运行测试均在临时 worktree 中使用独立端口、临时 Codex 数据和模拟 App Server；没有用这些结果替代生产环境验收。

| 验证 | 实际结果 |
|---|---|
| `npm ci --no-audit --no-fund` | 成功 |
| 依赖安装版本 | markdown-it 14.3.2、hono 4.13.8、fast-uri 3.1.8、ip-address 10.7.2、qs 6.16.0 |
| 记忆提取定向测试 | 3/3 通过，兼容当前 Codex 消息格式 |
| 归档及共享连接定向测试 | 22/22 通过，含不同线程并发归档与取消、归档 RPC 竞态、失败恢复、收藏保护、旧状态及旧远端记录 |
| 旧 Terminal 会话兼容与接口定向测试 | 2/2 通过；legacy 与 Platform 内核均能恢复历史并连续完成两轮；已鉴权 `/api/hosts` 返回 404，`/api/projects` 返回 200 |
| `npm test -- --test-concurrency=2` | 202/202 通过，0 失败、0 跳过 |
| 只读审查 | 归档侧录并发写入问题已修复并有回归覆盖；复核无剩余实质问题 |
| 生产服务只读基线 | active/running，PID 73386，启动时间 2026-10-04 11:34:57 CST；不能据此判断实际运行 commit |
| 生产重启与功能回读 | 用户已完成 14:22 首次重启、14:45 依赖安装后的再次重启和登录；已登录实测及剩余缺口见第 ⑤ 段 |

整合前本地仓库 commit 为 `86ed211`，整合提交为 `4e34dc4`，已推送 GitHub `main`。整合和本轮验收均没有从本 Session 重启服务。生产验收发现的 Side Chat 参数修复另有回归覆盖，并须继续遵守外部重启要求。
