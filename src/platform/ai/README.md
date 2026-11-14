# AI Platform

Android 流式传输失败时保留 React Native 返回的原生网络原因。错误回调中的 `responseText` 属于连接错误信息，不能覆盖此前实际接收的 SSE 正文；诊断记录分别保存已收到的响应和失败原因。超时分类优先于笼统网络分类，避免把 `Network request timed out` 提示成 API 地址错误。这些信息不等同于后台宿主被杀，不增加自动重试或保活逻辑。

这里提供跨业务的模型技术能力，不承载助手、聊天或语音业务规则。文本和向量走既有 OpenAI 兼容客户端；图片生成独立映射所选供应商的协议。

阿里百炼千问图片使用官方 DashScope 原生同步接口 `/api/v1/services/aigc/multimodal-generation/generation`。资产继续保存现有的百炼服务连接，图片客户端以该服务域名构造原生路径，不把 `/images/generations` 拼到旧域名的兼容地址下，也不要求重新填写 Key。提示词和参考图映射到 `input.messages[].content`，单张与尺寸放在 `parameters`，尺寸分隔符为 `*`；响应从 `output.choices[].message.content[].image` 提取并校验单张 HTTPS 图片。诊断省略嵌套的文字、参考图和结果签名 URL。协议依据见[千问图像生成与编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)。

Seedream 4.5 使用 `sequential_image_generation: disabled` 限定单图，5.0 Flash 原生只生成单图，不发送不支持的组图字段。新建 Seedream 配置默认使用 Flash，已有 4.5 资产保留原选择。GPT Image 文生图与编辑分别解析 `image_generation.*`、`image_edit.*` 流式事件，只接受对应接口的最终图片。上传限制由 `validateImageGenerationReference` 按供应商检查；Media 传入 Device 已检查的真实格式、尺寸与字节数，不重复读取或解码。当前支持模型的逐项核对与验证范围见[供应商核对记录](../../../docs/tasks/image-generation-provider-review-2026-11-14.md)。

## 职责

- `BaseAIClient.ts`：普通、流式、工具调用与向量请求的公共实现；
- `OpenAIClient.ts`：统一的 OpenAI 兼容客户端与创建工厂；
- `imageGenerationConfig.ts` / `ImageGenerationRequest.ts`：固定生图供应商、已适配模型与能力契约。硅基流动按完整模型 ID 映射：Z-Image 和 Qwen-Image 仅文生图，Kolors 允许可选参考图，两个 Qwen 编辑模型必须参考图且不发送 `image_size`；各自映射推荐尺寸，统一解析 `images[].url`。Qwen-Image 使用官方推荐的 50 步与 CFG 4。MiniMax 使用原生 `image_generation`，Seedream 使用 Images 契约，百炼千问使用 DashScope 原生同步契约，官方 GPT Image 参考图使用 multipart edits。自定义 OpenAI 模式已移除，旧 metadata 只识别为停用配置，不继续发送请求；配置读取边界确认供应商、官方地址和模型匹配。`ImageGenerationClient.ts` 拥有一次 HTTP、取消、180 秒等待、响应校验与脱敏，不重试、换模型或换协议。上传使用 Expo `File`，不用 `expo/fetch` 不支持的 RN `{ uri }` 文件对象。
- `ImageGenerationStream.ts`：只解析 GPT Image 的真实中间预览和最终图片，网络中断、服务端错误及无最终结果分别暴露；预览不等于完成百分比，不能作为最终图片提交。诊断仅保留脱敏后的请求形状与结果分类，省略提示词、参考图、图片字节与签名结果 URL。
- `officialToolsEndpoint.ts` / `OfficialToolsHttpClient.ts`：识别 Moonshot、DeepSeek 官方 API 根地址，共用凭据边界、HTTP 超时、取消、响应上限和脱敏错误；
- `MoonshotToolsClient.ts` / `DeepSeekToolsClient.ts`：各自映射搜索／网页抓取 REST 协议；Moonshot 另支持 mew、convert、rethink、random-choice、excel、date、base64 的固定 Formula 路由，验证官方声明后执行，原样返回普通或 protected 输出。工具权限和模型续轮由 Host 与统一 Runtime 持有；
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
