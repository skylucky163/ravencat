# MCP 聊天注入当前架构契约

> 状态：**IMPLEMENTED / CURRENT ARCHITECTURE**。本文描述当前代码的职责、数据流、边界和验收方式。
> 更新日期：2026-10-09。


## 1. 产品结果

MCP 接入聊天后，模型每轮只在工具请求中看到固定的两个 meta-tool：

- mcp_list_tools：从本轮冻结的授权工具定义中按需读取服务摘要、工具目录或单个工具的参数 schema，不联网。
- mcp_call_tool：按服务显示名和远端工具名执行一个已经通过权限与 schema 校验的远端工具。

获授权 AI 的聊天 Prompt 会常驻一份轻量服务摘要，单聊与群成员回复使用同一工具说明组装路径。摘要只包含该 AI 可用服务的显示名和用户填写的简介，不包含远端工具列表或完整 JSON Schema。模型需要真正使用某个服务时，先调用 mcp_list_tools，再调用 mcp_call_tool。这样每轮模型请求的 tools schema 不随 MCP 工具数量增长。

MCP 仍然走既有 AgentRuntime、AgentToolRegistry、AgentRunLoop、工具 observation、取消和 run 生命周期；没有复制第二套聊天循环或消息提交流程。

## 2. 领域与权限契约

### 2.1 服务身份

服务显示名同时承担 Prompt 中的选择标签和模型侧 serverName。SaveMcpServer 在 application 边界执行以下约束：

- 去除首尾空白；
- 名称最多 100 个字符；
- 拒绝换行及控制字符；
- 通过 repository.list() 拒绝其他 ID 的 trim 后同名配置；
- 简介去除首尾空白，将 CRLF 规范化为 LF，最多 500 个字符。

同名历史数据不会通过 UNIQUE 索引强行迁移失败。运行时遇到无法区分的同名服务会直接报告内部不变量错误或返回 MCP_SERVER_AMBIGUOUS observation，绝不静默选择其中一个。

MCP 工具的内部权限/allowlist 名称由发现阶段生成，格式为：

    mcp.<serverId>.<sanitizedRemoteName>

serverId 和 localToolName 只在内部权限和冻结定义中使用。模型协议使用 serverName 和 remoteToolName；模型不需要知道带 serverId 的内部名称。

### 2.2 持久化

mcp_servers.description 是 TEXT NOT NULL DEFAULT ''。新库由 MCP schema 创建，旧库由迁移 65 通过 PRAGMA table_info 检查后追加该列，旧行得到空字符串。

McpServerConfig、SQLite 行映射、Repository save 输入和 URL 失效更新都携带 description。row mapper 信任 SQLite 的 NOT NULL contract，直接读取 description，不在下游添加空值 fallback。

编辑 URL 表示连接了另一个 MCP Server。invalidateAndUpdateEndpoint 在同一事务内更新名称、URL、简介并清除 enabled、连接诊断、快照和工具授权，因此 URL 变化不会丢失简介，也不会留下旧 Server 的授权状态。

配置 UI 在 Server URL 后提供“服务简介（可选，注入 AI 上下文）”多行输入框。新建时默认为空，编辑时读取已保存简介；名称和简介的 UI maxLength 与 application 限制一致。

### 2.3 唯一执行门控

一个远端工具只有同时满足以下条件，才会进入本轮冻结执行定义：

1. 当前 Assistant 实体 ID 位于该服务的 `mcp_server_assistants` 授权中；
2. Server enabled 且 connectionStatus 为 available；
3. 最近一次成功发现快照中存在该工具，且 grant enabled、schema fingerprint 一致；

首次保存必须选择至少一位生效 AI；新增页不预选对象，之后可清空选择。服务列表的多选即时保存，每次只更新一个对象，不覆盖其他对象的选择。迁移112创建空授权表，旧服务不自动回填全局权限；删除服务或 AI 时外键级联清理对应授权。

MCP Server 配置页是 MCP 授权的唯一产品边界。连接测试成功后，Server、发现快照与工具授权在
一个 SQLite 事务中提交：Server 默认启用，首次发现和新增工具默认启用；已有工具保留用户在
MCP 配置页明确关闭的状态。提示词中心不再为 MCP 保存 `assistant_tool_permissions`，也不展示
具体远端工具名。

权限关闭、快照损坏、Repository/Runtime 依赖失败和命名不变量错误都不能被伪装成“没有 MCP”。没有可用工具是正常的空结果；内部源错误直接暴露给上层。

### 2.4 独立协议测试与成功链路

配置页分别调用 `testMcpServerConnection(serverId, 'legacy' | 'modern')`。Host 只装配对应 Adapter：传统链路直接 `initialize`，新版链路只执行 `server/discover`，测试过程中不会跨协议切换。两条链路复用同一应用用例的工具发现、授权与事务提交。

任一测试成功即可发布新的 `protocolEra` / `protocolVersion`、工具快照与授权并启用服务；多次成功以最后一次成功提交为准。聊天冻结成功快照中的精确协议并通过 `knownProtocol` 创建运行期 Client。传统连接使用固定版本握手，新版连接无需再次发现；运行期失败不能跨协议重放工具调用。

`recordConnectionFailure` 只更新尚未验证成功的当前连接。SQLite 在同一条条件写入中检查 URL、凭据引用与 `connection_status <> 'available'`，因此失败的另一条测试或较晚结束的失败不会关闭已成功的服务，也不会覆盖成功诊断、快照、授权与用户的启用选择。当次失败由 UI 报告。地址或认证身份改变仍由配置事务失效全部旧成功事实，不能保留另一个服务或账号的协议。

## 3. Chat 数据流

一次普通 Chat 回复的 MCP 相关链路如下：

~~~
ProcessAIReply
  └─ resolveMcpExposure(assistantId)
       └─ 读取当前 AI 获授权的 enabled + available Server、当前快照与 grant
       └─ 返回 McpExposureBundle：
            allowedToolNames：具体 localToolName，供 policy/task 使用
            services：按服务聚合的 name + description，供 Prompt 使用
  └─ 将 bundle 写入本轮 runtimeContext
  └─ Prompt 组装消费同一份 services
  └─ Agent host 在 run 启动时按 task.assistantId 重新读取并最终冻结执行定义
       └─ selected = 最新冻结定义 ∩ task allowlist
       └─ selected 非空时注册两个 meta-tool
       └─ 从 task allowlist 移除全部具体 MCP 名称，加入两个 meta-tool 名称
  └─ AgentRunLoop.listAllowed 只向模型提供内置工具和 meta-tool
~~~

McpExposureBundle 是 policy 边界的一次性暴露结果，保证服务摘要和本轮候选工具来自同一个解析结果。run 启动时的再次冻结是执行权威，用于防止 Prompt 组装和真正执行之间配置、快照或授权发生变化；它不会把新的 MCP 能力反向添加到已经裁决的 task。

AI 工具总开关关闭时，ProcessAIReply 不读取 MCP 暴露面；run 也不读取 MCP source。群聊与图片输入不会额外取消已授权的工具，最终执行仍使用本次 task allowlist 与最新授权的交集。

## 4. Prompt 服务摘要

ChatReplyRuntime 将本轮 mcpServices 传入 Prompt Pack 参数。服务摘要复用现有 tools_description provider，和工具行为规范合并在同一个 tools_description block 中，不创建独立的 mcp_services PromptBlockKey、catalog definition或 preset item。该动态工具说明属于运行契约，不能再由每 AI 的提示词状态关闭；提示词中心的 MCP 服务开关直接映射真实 `mcp_servers.enabled`。

摘要具有以下形式和边界：

- 中文使用“【已启用的 MCP 服务】”，英文使用对应的 ENABLED MCP SERVICES 文案；
- 每个服务是一行 JSON 字符串对象，始终包含 name；只有简介非空时才包含 description；
- 用户配置内容被视为数据，不是指令；JSON 包裹避免多行简介伪装成系统条目；
- Prompt 内单个服务名最多 120 个字符，简介最多 600 个字符；
- 服务摘要总长度最多 3,000 个字符，超出部分按完整条目省略并保留省略提示和使用说明；
- 使用说明明确要求先调用 mcp_list_tools，再调用 mcp_call_tool；
- 初始 Prompt 永远不携带远端工具列表和参数 schema。

应用层的 100/500 字符限制先保护数据写入边界，Prompt factory 的 120/600/3,000 限制再保护最终上下文边界。Prompt 摘要只说明“有哪些服务以及用途”，不等同于执行授权；真正执行仍以 run 冻结定义为准。

MCP-only 场景没有内置工具说明时，Host 提供最小的 toolsDescription 行为规范，使现有 tools_description provider 仍能装配服务摘要；这个 fallback 只是一段工具调用规则，不会把具体 MCP schema 重新放回初始 Prompt。

## 5. 两个 meta-tool

### 5.1 mcp_list_tools

固定 descriptor：

    name: mcp_list_tools
    owner: mcp:meta
    source: mcp
    risk: safe_read
    idempotency: idempotent

模型输入 schema：

~~~json
{
  "type": "object",
  "properties": {
    "serverName": {
      "type": "string",
      "description": "MCP 服务名；不传时只返回可用服务摘要"
    },
    "remoteToolName": {
      "type": "string",
      "description": "远端工具名；传入后只返回该工具的完整参数 schema"
    }
  },
  "additionalProperties": false
}
~~~

执行语义：

- 不传 serverName：只返回当前冻结名单中的服务名和简介，不泄漏工具名；
- 传 serverName：返回该服务的工具名和简介；目录较小时附带完整 schema；
- 同时传 serverName 和 remoteToolName：只返回指定远端工具的完整 schema；
- serverName 不存在、服务名歧义或工具不在当前冻结名单时，返回带可用清单的 error observation；
- 所有数据来自构造时注入的 ReadonlyArray<McpFrozenToolDefinition>，不建立网络连接。

单次目录最多展示 64 个工具。观察结果总字符上限为 16,000；目录过大时只展示工具名/简介，并要求模型按 remoteToolName 查询单个 schema。单个 schema observation 上限为 96,000 字符。发现阶段的 inputSchema 还受嵌套深度 20 层和序列化 64 KiB 限制。

### 5.2 mcp_call_tool

固定 descriptor：

    name: mcp_call_tool
    owner: mcp:meta
    source: mcp
    risk: external_side_effect
    idempotency: not_idempotent

模型输入 schema：

~~~json
{
  "type": "object",
  "properties": {
    "serverName": {
      "type": "string",
      "description": "MCP 服务名（来自服务摘要）"
    },
    "remoteToolName": {
      "type": "string",
      "description": "远端工具名（来自 mcp_list_tools）"
    },
    "arguments": {
      "type": "object",
      "description": "远端工具参数对象；无参数工具可省略"
    }
  },
  "required": ["serverName", "remoteToolName"],
  "additionalProperties": false
}
~~~

执行顺序：

1. 用 serverName 查找唯一服务，再用 remoteToolName 查找冻结的远端工具定义；
2. arguments 缺省时使用空对象；
3. 在联网前使用 shared/aiTools/AgentToolInputSchema.ts 导出的 matchesAgentToolInputSchema，按该具体远端工具的冻结 inputSchema 校验 arguments；
4. 校验失败返回 MCP_TOOL_INPUT_INVALID observation，不建立连接；
5. 校验通过后通过本 run 的 McpRunClientPool 获取连接，使用 remoteToolName 调用远端 tools/call，并把同一个 abort signal 和冻结 inputSchema 传给 Client；
6. 复用统一 MCP 结果转换，把文本/结构化内容转换为 AgentTool observation，并受 16,000 字符观察上限约束。

具体 schema 校验不是只依赖 mcp_call_tool 外层的“object”约束。外层 schema 保证模型调用协议，shared validator 才保证选定远端工具的真实参数契约；两者职责不同且不复制实现。

可由模型修正的服务不存在、工具不存在、参数不符合 schema、协议错误会返回 error observation。取消会沿 Runtime 生命周期上抛；未知编程错误不会被吞掉或伪装成模型可修正错误。

## 6. Agent run、预算与生命周期

当本轮 selected MCP 工具非空时，Host 注册固定两个 meta-tool，并将 task.allowedToolNames 中的具体 MCP 名称全部替换为 meta-tool 名称。这样 AgentToolRegistry 的未知 allowlist 检查不会收到已经不在 Registry 中的具体工具名。

MCP 与 Built-in Tool 使用同一份 Chat 预算，不再由 Host 按工具来源提高 `maxSteps`。当前统一预算为
30 个工具回合、每回合最多 3 次、总计最多 30 次；工具额度耗尽后额外保留一次无工具最终回答。
该预算覆盖常见的：

    list → call → final

以及一次失败 observation 后的纠正调用：

    list → failed call → corrected call → final

AgentRuntime 仍是唯一模型循环；每个 run 只创建一个 McpRunClientPool，同一 Server 的多次 call
复用连接，run 成功、失败、取消都会由 trackChatAgentRun 收口 dispose。`mcp_list_tools` 与
`mcp_call_tool` 都进入 Chat 时间线；后者显示 `serverName / remoteToolName`，不得只显示笼统的
“MCP 服务”。

Headless execution host 已显式装配 MCP：

    configurePromptingRuntime()
    configureMcpToolsRuntime()
    configureChatRuntime()
    configureAIRuntime()
    ...

前台 Host 也通过 configureMcpToolsRuntime 注入同一组 Repository 和 NegotiatingMcpClient。冷启动 Headless 回复不依赖前台页面初始化 MCP。

## 7. 实现映射

数据和配置：

- src/platform/persistence/sqlite/mcpSchema.ts
- src/platform/persistence/sqlite/migrations.ts（迁移 65）
- src/features/mcpTools/domain/McpServerConfig.ts
- src/features/mcpTools/domain/McpServerConfigRepository.ts
- src/features/mcpTools/infrastructure/SQLiteMcpServerConfigRepository.ts
- src/features/mcpTools/application/SaveMcpServer.ts
- src/features/mcpTools/application/McpConfigError.ts
- src/features/mcpTools/presentation/McpServerConfigScreen.tsx

运行时与模型协议：

- src/host/composition/agent/McpAgentTool.ts
- src/host/composition/agent/registerMcpAgentTools.ts
- src/host/composition/agent/registerMcpToolsForHostRun.ts
- src/host/composition/agent/index.ts
- src/host/composition/configureChatRuntime.ts
- src/host/composition/configureBackgroundExecutionRuntime.ts
- src/shared/aiTools/AgentToolInputSchema.ts
- src/platform/agentRuntime/AgentToolExecutor.ts

Prompt：

- src/features/chat/reply/application/ProcessAIReply.ts
- src/features/chat/reply/application/ChatReplyRuntime.ts
- src/features/chat/reply/application/ChatReplyRuntimeDependencies.ts
- src/features/chat/reply/application/ChatReplyTypes.ts
- src/shared/prompt/types.ts
- src/host/prompt/PromptPackBlockFactory.ts
- src/host/prompt/providers/HostPromptProviderRegistry.ts

## 8. 验收清单

### 8.1 数据与 UI

- 新建和编辑 MCP Server 可以保存简介；重新打开配置页能读取简介。
- 首次新增不预选 AI，至少勾选一位后才能保存或测试连接；列表直接多选即时保存，编辑可清空。
- 切换角色模型不改变服务授权，新增 AI 不继承授权；旧服务升级后等待明确选择，删除 AI 后关联自动清理。
- description 的 trim、CRLF→LF 规范化和 500 字符上限生效。
- name 的 100 字符、控制字符和同名检查生效。
- 变更 URL 后简介保留，同时旧连接状态、发现快照和工具授权失效。
- 连接测试成功后，Server 状态、发现快照和工具授权在一个事务内提交；Server 默认启用，首次发现和新增工具默认启用。
- 提示词中心只展示 MCP 服务级注入状态，开关直接映射真实 Server；不出现具体 MCP 工具名，也不写 per-AI MCP 权限。
- 旧库运行迁移 65 后，已有 mcp_servers 行的 description 为非 NULL 空字符串。

### 8.2 MCP meta-tool

- mcp_list_tools 不传 serverName 时只返回服务摘要，不泄漏具体工具名。
- 按 serverName 可列工具；按 serverName + remoteToolName 可取单个完整 schema。
- mcp_call_tool 使用 serverName + remoteToolName，不要求模型传内部 localToolName。
- 具体参数 schema 校验失败时不触网；通过校验后才连接并调用。
- list/call 使用同一份冻结定义、同一 run connection pool 和同一 abort signal。
- 同名服务、损坏快照、Repository/runtime 源错误和未知编程错误不能被静默吞掉。
- 观察结果、服务目录、单个 schema 和发现快照尺寸上限生效。

### 8.3 Chat policy 与生命周期

- MCP Server、生效 AI 关联与工具 grant 是唯一持久授权事实；Chat policy 决定本轮是否允许工具，不写 assistant_tool_permissions。Chat 与主动任务都传递 Assistant 实体 ID，Prompt 与执行冻结共用同一生效对象规则。
- policy 关闭时不读取 MCP source，不注册 meta-tool。
- selected 非空时 Registry 只有固定两个 MCP meta-tool，task 中没有具体 MCP 名称。
- selected 为空时不注册 meta-tool，普通工具任务继续按原契约运行。
- MCP-only 任务仍开启工具 policy，并使用统一 Chat 工具预算。
- 群聊和图片输入不额外取消已授权的 MCP；是否暴露仍由当前 AI、Server、快照与工具授权共同裁决。
- 前台与 Headless 都能完成 MCP runtime 装配；run 结束会 dispose 连接池。

### 8.4 自动化验证

按改动范围执行以下检查：

    npm run typecheck
    npx eslint <本次修改的 TypeScript/TSX 文件>
    npm run architecture:sqlite
    npm run verify:mcp
    npm run verify:mcp:chat
    npm run verify:agent-runtime
    npm run verify:prompt

MCP 边界验证覆盖新增必选、列表即时修改与编辑清空、SQLite 授权事务与外键清理、连接成功原子提交与默认授权、快照与授权交集、meta-tool 服务摘要不泄漏工具、具体 schema 联网前校验、abort signal 传递、连接复用、同名服务错误、未知异常透传和协议边界。MCP Chat exposure 验证覆盖生效 AI 隔离、准备后撤销的执行冻结、policy 关闭、MCP-only、群聊/图片场景、allowlist 替换、固定 meta-tool 注册和内部错误透传。AgentRuntime 验证覆盖共享 schema validator 与工具执行边界；Prompt 验证覆盖服务级真实状态、provider/catalog/golden/locale 等现有 Prompt contract。

真机或模拟器验收还应覆盖：配置 MCP Server 并成功完成连接测试，确认 Server 与全部首次发现工具自动启用，且无需在提示词中心再次授权；确认首轮请求只带两个 meta-tool，模型先 list 后 call；空简介服务只注入名称；故意传错 arguments 时观察不会触网并能收到修正提示；取消或后台 Headless 执行后确认连接池正常收口。

## 9. 当前边界

本实现只覆盖已接入的 Streamable HTTP、2025/2026 协议协商和既有 MCP 权限模型。OAuth、外部企业 MCP、legacy SSE 等不属于本功能的执行契约。服务摘要是模型选择上下文，不是新的授权来源；所有远端执行必须经过 run 最终冻结和具体 schema 校验。
