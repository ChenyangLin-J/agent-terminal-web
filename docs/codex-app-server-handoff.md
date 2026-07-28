# Codex App Server 接入与部署避坑

这份文档面向准备把现有 Workbench 改造成 Codex App Server 应用的同事。
它总结的是 Agent Web 已经遇到并解决的问题，不是一套必须照搬的完整产品方案。

当前实现验证环境：

- Node.js `20.20.2`
- npm `10.8.2`
- `codex-cli 0.145.0`
- Codex App Server 默认 JSONL stdio transport

Codex App Server 的协议和事件仍可能随 Codex CLI 更新。升级 CLI 后必须重新跑协议与并发测试。

## 建议的最小架构

```text
Workbench Web / API
        │
        ▼
应用后端
├─ 每个执行主机一个共享 App Server connection
├─ 每个业务 Session 一个 thread-scoped client
└─ 保存 Web Session ↔ Codex threadId 的映射
        │
        ▼
codex app-server（JSONL stdio）
```

不要把 `codex app-server` 直接监听到公网。当前 Agent Web 由应用后端通过 stdio
启动 App Server，网页只连接经过鉴权的应用后端。

最小调用顺序：

1. 启动 `codex app-server`，stdin/stdout 使用逐行 JSON。
2. 调用 `initialize`，成功后发送 `initialized`。
3. 新会话调用 `thread/start`，恢复会话调用 `thread/resume`。
4. 保存返回的 `thread.id`。
5. 调用 `turn/start`，保存返回的 `turn.id`。
6. 消费 notification，并处理 App Server 主动发来的带 `id` request。
7. 收到 `turn/completed` 后结束本轮状态。
8. Web Session 释放时调用 `thread/unsubscribe`，不要顺手关闭共享进程。

核心客户端代码：

- `lib/codex-app-server-client.js`
- `lib/agent-host-app-server.js`

## 已经遇到的问题

### 1. 每个 Session 启一个 App Server，进程和 MCP 会快速膨胀

最早的实现是一个 Web Session 对应一个 `codex app-server`。Session、Side Chat
和元数据查询增多后，App Server 进程和它们带起的本地 MCP Provider 会一起增加。

当前解决方式：

- 每个执行主机只维护一个按需启动的 `CodexAppServerConnection`。
- 每个 Session 使用独立的 `CodexAppServerClient`，但共享底层 connection。
- client 只保存自己的 `threadId`、`activeTurnId`、队列和事件监听。
- 关闭一个 Session 时先 `thread/unsubscribe`，不能关闭共享 connection。

如果 Workbench 第一版只有单用户、单 Session，可以先不做 Pool；但接口层仍应把
connection 和 thread client 分开，避免后面重构。

### 2. 共享进程后，事件和审批会串到其他 Session

App Server 的 notification 和 server request 都从同一个 stdout 返回。只按事件类型
广播，会让一个线程的完成事件、命令输出或审批请求进入另一个页面。

当前解决方式：

- notification 和 server request 都先提取 `params.threadId`。
- 只有 `threadId` 与 client 当前线程一致时才继续处理。
- 每个 client 单独维护 active turn，子 Agent 的 turn 不能覆盖主线程状态。
- 释放 client 时移除全部 listener，防止旧 Session 继续收到事件。

至少要用两个并发 thread 测试：

- 输出不会串线；
- 审批请求只到正确页面；
- 关闭其中一个 client 不会杀掉另一个；
- 子 Agent 的 turn 不会改写主 Agent 的 active turn。

### 3. “追加当前”和“下一轮”存在竞态

用户发送补充消息时，上一轮可能恰好完成。如果只判断本地的“正在运行”状态，
消息可能 steer 到错误的 turn，或在完成瞬间丢失。

当前解决方式：

- 追加当前使用 `turn/steer`，同时发送 `expectedTurnId`。
- 返回的 `turnId` 必须等于预期 turn，否则报错。
- 下一轮由应用自己排队，只在收到 `turn/completed` 后调用 `turn/start`。
- 如果 steer 时服务端已经没有 active turn，本地清空 active 状态，并保留消息供新 turn 使用。
- 用 `completedTurnIds` 处理“turn 在 `turn/start` response 返回前就已完成”的极短竞态。

不要把所有补充消息都直接调用 `turn/start`，也不要只依赖网页按钮点击时的状态。

### 4. 恢复 Session 后误判 turn 已结束

只恢复 `threadId` 不够。如果服务重启或网页断开时 turn 仍在运行，重新连接后容易显示
为空闲，导致新消息与未完成任务冲突。

当前解决方式：

- `thread/resume` 时请求最近的 `initialTurnsPage`。
- 检查最近 turn 中是否存在 `status === "inProgress"`。
- 恢复 `activeTurnId` 和应用侧 turn 状态。
- 如果 App Server 进程丢失，把未完成 turn 标记为 interrupted，而不是 completed。
- 页面提供“继续完成”，重新恢复原 thread 后提交剩余要求。

需要分别测试：

- 正常完成后的恢复；
- 运行中的恢复；
- 恢复 response 与 `turn/completed` 同时到达；
- App Server 异常退出后的恢复；
- 用户主动中断与进程丢失的区别。

### 5. `error` notification 会触发 Node EventEmitter 的特殊语义

Node.js 对名为 `error` 的 event 有特殊处理：没有 listener 时直接抛异常。App Server
会发送 `method: "error"` 的普通 notification，例如自动重连提示。直接执行
`emitter.emit(message.method)` 曾导致整个客户端崩溃。

当前解决方式：

- 所有消息先统一发到普通的 `notification` event。
- 只有存在显式 `error` listener 时，才额外 emit `error`。
- 协议解析失败使用独立的 `protocol-error`，并保留经过限制的原始日志。

不要把外部协议 method 不加判断地映射为 Node EventEmitter event。

### 6. App Server 会主动向客户端请求审批和用户输入

命令、文件修改、权限扩展和工具提问不是普通 notification，而是带 request `id`
的 server-initiated JSON-RPC request。如果应用只消费 notification，turn 会一直等待。

当前至少处理：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `mcpServer/elicitation/request`

当前解决方式：

- 按 request `id` 保存 pending request。
- 通过 `threadId` 路由到正确 Session。
- 页面返回后，用同一个 `id` 回写 result。
- 未支持的 request 明确返回 JSON-RPC error，不能静默丢弃。
- Session 结束或连接退出时清理 pending request。

第一版如果不做审批 UI，可以把应用限定为 `approvalPolicy: "never"` 的只读场景；
不要假设 App Server 永远不会主动发 request。

### 7. 附件上传和 turn 提交会抢跑

用户点发送时，文件可能仍在上传。旧实现会先发送 prompt，附件稍后才出现，导致 Agent
根本拿不到文件。

当前解决方式：

- 前端维护所有 in-flight upload，并在提交前 `waitForUploads()`。
- 上传失败时保留 prompt，不发送不完整 turn。
- App Server 使用原生 structured input：图片用 `localImage`，其他文件用 `mention`。
- 后端只接受上传目录内的规范化路径，不能信任浏览器传来的任意本地路径。

### 8. 本地 MCP Provider 被重复启动，空闲时仍长期占资源

如果 Codex 全局配置里为每个 App Server 配本地 STDIO MCP command，每个 App Server
都会复制启动一套 Provider。Playwright 还会带起浏览器和持久 profile，资源与状态冲突
更明显。

当前解决方式：

- Codex 配置只连接应用提供的 loopback Streamable HTTP MCP endpoint。
- `initialize` 和 `tools/list` 直接读取版本化 manifest，不启动真实 Provider。
- 第一次 `tools/call` 才启动一个所有 Session 共用的后端。
- 无状态工具可以并发；Playwright 这类有状态工具必须串行。
- Provider 设置 idle timeout，空闲后回到零实例。
- 两个浏览器进程绝不能共用同一个 persistent profile。

实现和检查表见 `docs/shared-mcp-providers.md`。

### 9. 页面断开、Session 结束和服务重启是三件不同的事

早期实现容易把“网页断开”理解成“任务结束”，或者让 Agent 自己重启承载它的服务，
从而中断所有 Session。

当前解决方式：

- 页面断开只记录 detached 状态，thread 继续运行。
- 空闲一段时间后可以释放 runtime，但保留 threadId，用户下次发送时再恢复。
- “结束当前 Session”只中断该 Session，不影响共享 App Server 中的其他线程。
- Agent Web 进程禁止由其内部 Codex Session 自行 stop/restart。
- 部署完成后由外部终端或运维流程重启服务。

Workbench 也应把“WebSocket 断开”“业务 Session 结束”“App Server connection
退出”“应用部署重启”拆成不同状态。

### 10. 协议版本变化和未知事件不能拖垮整个应用

App Server 的事件类型在增加。UI 如果用一个完整枚举硬编码所有事件，升级 Codex CLI
后很容易因为未知字段或未知事件报错。

当前解决方式：

- 固定测试过的 Codex CLI 版本，升级时单独验证。
- JSON 解析错误、未知 notification、未知 item 和 stderr 分开处理。
- 未识别事件可以记录，但不能改变 turn 完成状态。
- 请求设置超时；connection 退出时 reject 所有 pending request。
- 日志限制长度，并对凭证和工具输出做脱敏。

## 部署建议

### 安全边界

- App Server 只由后端通过 stdio 启动，不对公网监听。
- Web 服务默认只监听 loopback，由反向代理完成 TLS 和登录鉴权。
- Codex 登录态、配置、Session、Skills 和 MCP 均保留在执行主机。
- 凭证放在仓库外，浏览器只能写入或替换，不能读取明文。
- 校验工作目录位于允许的 workspace 内。
- 默认使用受限 sandbox 和按需审批；只有可信环境才开放 full access。

### 进程与资源

- 每个执行主机一个共享 App Server connection。
- 每个业务 Session 一个 thread，不要用一个 thread 承载所有用户。
- Stateful MCP 串行，Stateless MCP 才考虑并发。
- 为 Session、Catalog、MCP Provider 和上传分别设置超时与大小限制。
- 检查 Session 数量增加时，App Server 与 Provider 进程数不会同比增长。

### 持久化

至少保存：

- 应用 Session id；
- Codex `threadId`；
- 当前或最后一个 `turnId`；
- 工作目录；
- sandbox / approval policy；
- 最近活动时间；
- 当前状态：active、completed、interrupted、released。

不要把页面渲染出来的文本当作唯一历史。恢复时以 Codex thread 为准，应用状态只负责
页面组织和异常恢复。

## Workbench 推荐迁移顺序

### 第一阶段：跑通单线程

- 接入 `initialize`、`thread/start`、`thread/resume`、`turn/start`。
- 能显示最终回答、工具调用和错误。
- 支持最少一种权限模式。
- 保存 `threadId`，刷新页面后可以恢复。

### 第二阶段：补齐可靠性

- 处理 server request 与审批。
- 处理 active turn、interrupt、steer 和下一轮队列。
- 加入断线恢复、附件等待和协议错误日志。
- 建立固定版本的协议回归测试。

### 第三阶段：并发与工具

- 改为每个执行主机共享 App Server connection。
- 验证多 thread 的事件、审批和 turn 状态完全隔离。
- 将本地 MCP 改为共享、按需启动的 HTTP Provider。
- 再评估多主机、Side Chat、Realtime、记忆和复杂 Session 管理。

不要一开始复制 Agent Web 的所有功能。对 Solvely Workbench 来说，先跑通业务数据工具、
可靠取数和可恢复的 thread，比 Session 分享、语音、记忆或多主机更重要。

## 上线前检查

- `codex --version` 与测试版本一致。
- 执行主机已完成 Codex 登录。
- `npm ci` 和 `npm test` 通过。
- 两个并发 thread 不串输出、不串审批。
- 同一 turn 的 steer 与下一轮 queue 都通过竞态测试。
- 刷新、断网、App Server 退出后能恢复或明确标记 interrupted。
- 审批和提问不会无限 pending。
- 附件上传完成后才提交。
- Session 增加时 App Server 与本地 MCP 进程数保持有界。
- 未知事件和 `method: "error"` 不会让 Node 进程退出。
- 服务只监听内网或 loopback，公网入口经过鉴权。
- 日志、源码包和错误响应不包含凭证。

## 参考文件

- `APP_SERVER_MIGRATION.md`：Agent Web 当前 App Server 行为。
- `lib/codex-app-server-client.js`：JSON-RPC connection、thread client、turn 与队列。
- `lib/agent-host-app-server.js`：每个执行主机的共享 connection pool。
- `docs/shared-mcp-providers.md`：共享、按需启动 MCP Provider。
- `docs/multi-host.md`：通过 SSH stdio 连接另一台执行主机。
- `test/app-server-client.test.js`：turn 竞态、恢复和多 thread 隔离。
- `test/shared-app-server.test.js`：共享进程与 rollback。
- `test/app-server-runtime-lease.test.js`：空闲释放与恢复。
- `test/attachments.test.js`：附件等待与路径校验。
- `test/restart-protection.test.js`：避免 Agent 自己重启承载服务。
