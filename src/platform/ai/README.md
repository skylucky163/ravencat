# AI Platform

Android 流式传输失败时保留 React Native 返回的原生网络原因。错误回调中的 `responseText` 属于连接错误信息，不能覆盖此前实际接收的 SSE 正文；诊断记录分别保存已收到的响应和失败原因。超时分类优先于笼统网络分类，避免把 `Network request timed out` 提示成 API 地址错误。这些信息不等同于后台宿主被杀，不增加自动重试或保活逻辑。

这里提供跨业务的文本模型技术能力，只负责调用 OpenAI 兼容 Provider，不承载助手、聊天或语音业务规则。

## 职责

- `BaseAIClient.ts`：普通、流式、工具调用与向量请求的公共实现；
- `OpenAIClient.ts` / `KimiClient.ts`：Provider 客户端与创建工厂；
- `moonshotEndpoint.ts` / `MoonshotToolsClient.ts`：识别 Moonshot 官方 OpenAI 根地址，执行搜索／网页抓取 REST 请求与 mew Formula 调用，验证响应及官方参数声明；工具权限和模型续轮由 Host 与统一 Runtime 持有；
- `modelDiscovery.ts`：发现模型列表；
- `connectionTest.ts`：单次连接测试，不额外发起工具支持探测；
- `errorMapping.ts`：把外部错误转换为稳定的展示信息；聊天、通话、模型连接测试与群管理员通过 `includeDetails` 保留具体原因；
- `types.ts`：请求、响应、流式增量和错误契约。
- `HttpExchangeDiagnostics.ts` / `HttpExchangeCapture.ts`：用户主动开启的本机 HTTP 原文诊断，入口在「小程序 → AI 工具 → AI 请求诊断」。记录 `BaseAIClient` 实际发送的对话请求正文和解析前响应文本，非流式、Fetch SSE、Android XHR SSE 共用；每次参数重试独立记录，不触发额外模型请求，也不修改模型输出。向量、模型列表和其他工具 HTTP 不在采集范围内。

HTTP 诊断默认关闭，开关和最近 10 次已结束请求的完整正文持久保存在应用私有目录，超过 10 条时淘汰最旧记录；重启、覆盖更新和系统清理缓存均保留开关与记录。首次读取时将旧缓存中尚存的已提交文件迁入长期目录。关闭只停止新增采集，已有记录仍可查看；手动清空保留当前开关，全局数据重置删除记录并关闭开关。不自动上传、不进入应用备份。鉴权头不进入采集接口，已知 API key 和 URL 凭据在保存前脱敏；因此这是「正文原文（凭据除外）」而非含鉴权的完整网络报文。用户可分页查看原文，并分别复制完整请求正文或完整响应正文，正文仍可能含提示词、思考、聊天与工具内容。流式记录保留客户端实际收到的 SSE 原文，取消时保留取消前文本；已丢失的历史响应不会补录。清空、关闭以及全局数据重置会失效在途捕获，迟到响应不能重新填入已清空的记录。诊断写入失败在页面显示，不把旁路存储错误升级为聊天失败。

HTTP 拒绝保留状态与 Provider 错误码/描述，非 JSON 错误保留正文；HTTP 200 中的流式 `error` 帧同样按失败返回，不误判为空回复或成功。对话错误离开客户端前脱敏当前 API Key。Fetch 与 Android XHR 使用相同语义，诊断仍保存解析前响应。

模型列表失败保留 HTTP 状态与响应正文，由模型设置层完成一次展示映射，不在底层先转换成中文通用提示。模型列表、对话与向量请求在各自接口边界统一脱敏当前密钥及其 JSON／URL 转义形式，下游直接消费错误契约。连接测试的参数专用提示同时保留接口原因与调整建议。

业务代码统一从 `@platform/ai` 导入。TTS、STT 客户端属于 `@features/speech`，不与文本模型客户端混放。

Temperature / Top P 未配置或为 null 时，普通、流式、工具请求与连接测试均不发送对应字段，由服务商决定默认值；显式数值（包括 0）原样发送。客户端不补充本地采样默认值，也不根据模型名自动覆盖参数。

聊天用量来自服务商的 `usage`，流式请求显式要求 `stream_options.include_usage`。缓存命中读取 `prompt_tokens_details.cached_tokens` 或 DeepSeek 的 `prompt_cache_hit_tokens`，在 Provider 边界归一化为可选的 `cachedTokens`；缺失与 0 分开表达。缓存量已包含在输入 token 中，不再次加到总量；流式累计帧按服务商最新统计更新，不把各帧相加。

`disableThinking` 对已支持的可切换模型明确表达两端：`false` 开启思考，`true` 关闭思考。Qwen／百炼使用 `enable_thinking`，OpenRouter 使用 `reasoning.enabled`，其他兼容接口使用 `thinking.type: enabled / disabled`。已识别的可切换模型包括 Qwen3（排除固定思考、Instruct 与 Preview）、Qwen Plus/Flash/Turbo、DeepSeek V3.1/V3.2/V4、Kimi K2.5/K2.6 和 GLM 4.6/4.7/5/5.1/5.2；不能因百炼 Kimi 默认不思考而把开关关闭误解为省略参数。未提供开关的调用、未识别模型与非思考模型在未选择关闭时仍沿用服务商默认。连接测试、流式与非流式共用请求构造；不通过隐藏返回内容伪装关闭思考，不为关闭参数错误自动降级重试。固定思考模型或不同参数契约的自部署接口不保证支持该选择。

DeepSeek 官方接口默认启用思考。带工具请求在首次发送前为纯历史 assistant 正文补齐 `reasoning_content: ''`，表示该历史投影没有协议思考记录；已有思考（包括空串）原样保留。真实工具续轮由 Agent Runtime 回传模型思考，不用空格伪造，也不补写缺失的工具轮思考。此适配由 Provider 请求边界独占，无工具、关闭思考或其他接口不自动添加字段；账本与日程继续保持系统触发身份，不追加假的用户输入。协议依据见 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

纯历史补空是已验证的接口兼容行为，不恢复历史思考，也不代表服务商对所有型号的承诺。适用条件只由客户端请求构造判断，不向业务或 Agent 请求暴露修补开关，不根据错误文案补字段重试。工具续轮的真实思考（包括空串）在 complete、stream 与通话链路中原样传递，不做正文清洗；缺失时不制造占位，由服务端返回协议错误。这里仍是 OpenAI 兼容 Chat Completions 客户端，不声明支持其他厂商原生签名或 Responses 消息项协议。

## 依赖方向

- Feature 和 app 组合代码可以依赖 `@platform/ai`；
- `platform/ai` 不依赖任何业务 feature；
- 只有本目录内部可以直接导入具体 Provider 文件。
