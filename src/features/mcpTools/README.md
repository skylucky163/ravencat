# MCP 工具服务

MCP Tools 拥有服务配置、工具发现快照与授权。聊天通过 Host 的固定 `mcp_list_tools` / `mcp_call_tool` 接入唯一 AgentRuntime，不为不同品牌新增业务调用循环。

## 配置入口

工具中心新增或编辑服务，可以手动填写名称、URL、简介和认证方式，也可以粘贴官方 `mcpServers` JSON。多服务配置先选择一个填入当前表单；导入本身不写数据库。支持远程 Streamable HTTP 和 Bearer Token，不支持手机端 command / stdio、本地进程环境变量、旧 SSE 或任意自定义请求头。

首次添加必须选择至少一位生效 AI，默认不勾选任何对象。新增页、已有配置页和服务列表均默认收起，仅显示生效 AI 摘要，点击展开修改；新增时标明必选。列表勾选即时保存；之后允许清空对象，表示任何 AI 都不注入此服务。授权绑定 AI 角色 ID，不随模型更换改变，也不自动授权后来添加的 AI。既有服务升级后等待用户选择生效对象。

新增时未选择生效 AI，点击测试会弹窗说明选择要求。测试成功只提示“连接成功”；工具授权默认收起，按需展开查看与调整，不自动展示工具发现详情。

新增与编辑共用配置表单，按服务信息、连接设置、生效 AI 和连接测试分组。JSON 导入位于连接设置标题旁；两种协议测试并列，不提供单独保存入口，删除作为页尾独立操作。协议和认证备份说明通过导航栏帮助查看。输入统一复用公共输入组件，主窗口由单个 `KeyboardAvoidingContainer` 负责键盘避让，导入弹窗由 `ModalSheet` 管理自己的窗口；JSON 与服务选择区域可收缩滚动，取消和读取配置按钮固定在滚动区外，避免键盘打开后被滚动边界裁切。

服务启停开关只在 MCP 工具列表逐项提供，列表内即时保存；新增页不显示该开关，保存后默认启用。服务需要成功连接并具有工具授权后，才会向所选 AI 暴露工具。

连接测试分成“传统握手测试”和“新版协议测试”，都会先保存当前表单，再执行所选协议与全量工具发现。连接成功或失败均保留本次配置；修改参数再次测试，会以最新版更新同一服务，不创建重复记录。传统握手直接执行 `initialize`，接受 `2025-06-18` / `2025-11-25`；新版协议执行 `server/discover`，接受 `2026-07-28`。两条测试互不切换，不把 HTTP 500 当成旧协议证据。

任一测试成功后，原子保存该协议、工具快照与授权并启用服务；两条都成功时使用最后一次成功测试的链路。首次发现和新增工具默认授权，已关闭的工具保留用户意图。页面显示“已验证链路”与协议版本，重新打开配置或重启应用后仍保留。聊天按成功快照固定协议：传统协议只做对应版本的握手，新版协议按已验证版本发送请求，不重复探测，也不在工具执行中跨协议重试。

失败测试报告当次错误，但不会覆盖当前配置已有的成功链路、快照或授权；数据库在失败写入时原子判断，较晚结束的失败也不能覆盖另一条刚提交的成功。尚未成功的配置记录失败状态。修改地址或认证身份仍会同事务清除旧连接诊断、快照和工具授权，需要重新测试，表单选择的生效 AI 同事务保存。

- [高德官方配置](https://lbs.amap.com/api/mcp-server/gettingstarted)：URL 为 `https://mcp.amap.com/mcp?key=YOUR_KEY`，选择无认证。
- [麦当劳官方配置](https://github.com/M-China/mcd-mcp-server)：URL 为 `https://mcp.mcd.cn`，选择 Bearer Token。
- [瑞幸官方配置](https://open01.luckincoffeecdn.com/)：URL 为 `https://gwmcp.lkcoffee.com/order/user/mcp`，选择 Bearer Token。

Token 输入不包含 `Bearer` 前缀。编辑时输入框留空保留已有凭据，更换 URL 后需重新填写。Token 日常保存在 Android 安全存储，数据库只保存引用；创建完整本地备份时按数据库快照引用导出，随稳定设置明文保存，恢复后写回安全存储并保留原引用。停用服务也包含在备份中；旧包未携带或原本缺失的 Token 仍需重新填写。新增的 expo-secure-store 原生模块必须进入开发壳，单独重载 Metro 无法添加模块。

## 所有权

- `application/`：输入与导入边界、配置命令、连接测试、凭据读取和授权查询；
- `domain/`：配置实体、Repository 与 Credential Store port；
- `infrastructure/`：SQLite 元数据事务与 SecureStore 凭据适配；
- `composition.ts`：Host 专用凭据实现与备份装配；
- `platform/mcp`：协议协商与 HTTP，统一携带 Authorization 并拒绝重定向；
- `shared/aiTools`：单一 JSON Schema 校验器，支持 draft-07、2019-09、2020-12 和局部 / 递归引用，不联网加载外部 schema、不修改参数。

连接测试以 URL + credentialRef 做提交 fence；更改配置期间完成的旧请求不能发布快照或失败状态。生效对象保存在 `mcp_server_assistants`，删除 AI 或服务时由外键清理。Chat 与主动任务在准备 Prompt 和执行冻结时都按当前 AI 筛选同一授权来源；准备后被撤销的服务不会进入执行冻结，已启动的 run 保持自己的冻结定义。run 只冻结凭据引用，在首次建立连接时读取 Token。同 URL 不同凭据隔离，同账号的并行请求共享一次创建与握手。

完整契约见 [MCP 聊天架构](../../../docs/architecture/mcp-chat-injection.md)。`verify:mcp` 验证导入、凭据生命周期、账号隔离、配置 fence 和协议；`verify:mcp:chat` 验证真实聊天暴露与权限，`verify:agent-runtime:contracts` 验证共享 Schema 行为。
