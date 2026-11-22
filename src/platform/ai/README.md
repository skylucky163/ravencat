# AI Platform

Android 流式传输失败时保留 React Native 返回的原生网络原因。错误回调中的 `responseText` 属于连接错误信息，不能覆盖此前实际接收的 SSE 正文；诊断记录分别保存已收到的响应和失败原因。超时分类优先于笼统网络分类，避免把 `Network request timed out` 提示成 API 地址错误。这些信息不等同于后台宿主被杀，不增加自动重试或保活逻辑。

这里提供跨业务的模型技术能力，不承载助手、聊天或语音业务规则。文本和向量走既有 OpenAI 兼容客户端；图片生成独立映射所选供应商的协议。

阿里百炼千问图片使用官方 DashScope 原生同步接口 `/api/v1/services/aigc/multimodal-generation/generation`。资产继续保存现有的百炼服务连接，图片客户端以该服务域名构造原生路径，不把 `/images/generations` 拼到旧域名的兼容地址下，也不要求重新填写 Key。提示词和参考图映射到 `input.messages[].content`，单张与尺寸放在 `parameters`，尺寸分隔符为 `*`；响应从 `output.choices[].message.content[].image` 提取并校验单张 HTTPS 图片。诊断省略嵌套的文字、参考图和结果签名 URL。协议依据见[千问图像生成与编辑 API](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)。

可灵 Image 4.0 使用国内开放平台的 Bearer API Key。通过 `POST /image-generation/kling-4.0` 提交单图任务，再使用同一任务 ID 查询 `GET /tasks`，仅接受该任务成功返回的单张 HTTPS 图片。提交和查询共享取消与 180 秒等待上限。同一次生成只提交一次，取消后停止查询。协议见[可灵 Image 4.0 生图 API](https://kling.ai/document-api/api/image/4-0/image-generation)。

自定义生图使用显式的 OpenAI Images 兼容配置，在用户填写的 HTTP(S) 基础地址后拼接 `/images/generations`。同步请求使用 Bearer Key，默认只发送 `model`、`prompt` 和 `n: 1`。响应接受单项 HTTPS `data[].url` 或 `data[].b64_json`。参数检测共用单次 POST 和诊断脱敏。用户选择的比例通过像素值 `size` 发送，使用实际文件尺寸验收同一宽高比。格式取自实际文件，画质根据响应顶层 `quality` 字段确认。Android 请求显式关闭重定向及底层重放。协议依据见 [OpenAI Images 创建图片](https://developers.openai.com/api/reference/resources/images/methods/generate)和 [New API 创建图片](https://docs.newapi.ai/en/docs/api/ai-model/images/openai/post-v1-images-generations)。

Seedream 4.5 使用 `sequential_image_generation: disabled` 限定单图，5.0 Flash 原生只生成单图，不发送不支持的组图字段。新建 Seedream 配置默认使用 Flash，已有 4.5 资产保留原选择。GPT Image 文生图与编辑分别解析 `image_generation.*`、`image_edit.*` 流式事件，只接受对应接口的最终图片。上传限制由 `validateImageGenerationReference` 按供应商检查；Media 传入 Device 已检查的真实格式、尺寸与字节数，不重复读取或解码。当前支持模型的逐项核对与验证范围见[供应商核对记录](../../../docs/tasks/image-generation-provider-review-2026-11-14.md)。

## 职责

- `BaseAIClient.ts`：普通、流式、工具调用与向量请求的公共实现；
- `OpenAIMessageDecoder.ts`：Chat Completions 的思考／正文分类、首段 think 标签状态机及本次工具续轮的原始思考载荷；非流式和两种 SSE 传输共用，业务层继续消费已有模型事件。
- `OpenAIClient.ts`：统一的 OpenAI 兼容客户端与创建工厂；
- `imageGenerationConfig.ts` / `ImageGenerationRequest.ts`：固定生图供应商、已适配模型与能力契约。硅基流动按完整模型 ID 映射：Z-Image 和 Qwen-Image 仅文生图，Kolors 允许可选参考图，两个 Qwen 编辑模型必须参考图且不发送 `image_size`；各自映射推荐尺寸，统一解析 `images[].url`。Qwen-Image 使用官方推荐的 50 步与 CFG 4。MiniMax 使用原生 `image_generation`，Seedream 使用 Images 契约，百炼千问使用 DashScope 原生同步契约，官方 GPT Image 参考图使用 multipart edits。配置读取边界确认供应商、官方地址和模型匹配。`ImageGenerationClient.ts` 拥有 HTTP 请求、取消、180 秒等待、响应校验与脱敏，不重试提交、换模型或换协议。上传使用 Expo `File`，不用 `expo/fetch` 不支持的 RN `{ uri }` 文件对象。
- `ImageGenerationStream.ts`：只解析 GPT Image 的真实中间预览和最终图片，网络中断、服务端错误及无最终结果分别暴露；预览不等于完成百分比，不能作为最终图片提交。诊断仅保留脱敏后的请求形状与结果分类，省略提示词、参考图、图片字节与签名结果 URL。
- `officialToolsEndpoint.ts` / `OfficialToolsHttpClient.ts`：识别 Moonshot、DeepSeek 官方 API 根地址，共用凭据边界、HTTP 超时、取消、响应上限和脱敏错误；
- `MoonshotToolsClient.ts` / `DeepSeekToolsClient.ts`：各自映射搜索／网页抓取 REST 协议；Moonshot 另支持 mew、convert、rethink、random-choice、excel、date、base64 的固定 Formula 路由，验证官方声明后执行，原样返回普通或 protected 输出。工具权限和模型续轮由 Host 与统一 Runtime 持有；
- `modelDiscovery.ts`：发现模型列表；
- `connectionTest.ts`：单次连接测试，不额外发起工具支持探测；
- `errorMapping.ts`：把外部错误转换为稳定的展示信息；聊天、通话、模型连接测试与群管理员通过 `includeDetails` 保留具体原因；
- `types.ts`：请求、响应、流式增量和错误契约。
- `HttpExchangeDiagnostics.ts` / `HttpExchangeCapture.ts`：用户主动开启的本机 HTTP 原文诊断，入口在「小程序 → AI 工具 → AI 请求诊断」。记录 `BaseAIClient` 实际发送的对话请求正文和解析前响应文本，非流式、Fetch SSE、Android XHR SSE 共用；每次参数重试独立记录，不触发额外模型请求，也不修改模型输出。向量、模型列表和其他工具 HTTP 不在采集范围内。

HTTP 诊断默认关闭，开关和最近 10 次已结束请求的完整正文持久保存在应用私有目录，超过 10 条时淘汰最旧记录；重启、覆盖更新和系统清理缓存均保留开关与记录。首次读取时将旧缓存中尚存的已提交文件迁入长期目录。关闭只停止新增采集，已有记录仍可查看；手动清空保留当前开关，全局数据重置删除记录并关闭开关。不自动上传、不进入应用备份。鉴权头不进入采集接口，已知 API key 和 URL 凭据在保存前脱敏；因此这是「正文原文（凭据除外）」而非含鉴权的完整网络报文。用户可分页查看原文，并分别复制完整请求正文或完整响应正文，正文仍可能含提示词、思考、聊天与工具内容。流式记录保留客户端实际收到的 SSE 原文，取消时保留取消前文本；已丢失的历史响应不会补录。清空、关闭以及全局数据重置会失效在途捕获，迟到响应不能重新填入已清空的记录。诊断写入失败在页面显示，不把旁路存储错误升级为聊天失败。

HTTP 拒绝保留状态与 Provider 错误码/描述，非 JSON 错误保留正文；HTTP 200 中的流式 `error` 帧同样按失败返回，不误判为空回复或成功。Android XHR 在接收过程中遇到流内错误时即进入失败收尾，保留此前收到的响应原文并释放连接。对话错误离开客户端前脱敏当前 API Key。

模型列表失败保留 HTTP 状态与响应正文，由模型设置层完成一次展示映射，不在底层先转换成中文通用提示。模型列表、对话与向量请求在各自接口边界统一脱敏当前密钥及其 JSON／URL 转义形式，下游直接消费错误契约。连接测试的参数专用提示同时保留接口原因与调整建议。

业务代码统一从 `@platform/ai` 导入。TTS、STT 客户端属于 `@features/speech`，不与文本模型客户端混放。

Temperature / Top P 未配置或为 null 时，普通、流式、工具请求与连接测试均不发送对应字段，由服务商决定默认值；显式数值（包括 0）原样发送。客户端不补充本地采样默认值，也不根据模型名自动覆盖参数。

聊天用量来自服务商的 `usage`，流式请求显式要求 `stream_options.include_usage`。缓存命中读取 `prompt_tokens_details.cached_tokens` 或 DeepSeek 的 `prompt_cache_hit_tokens`，在 Provider 边界归一化为可选的 `cachedTokens`；缺失与 0 分开表达。缓存量已包含在输入 token 中，不再次加到总量；流式累计帧按服务商最新统计更新，不把各帧相加。

## 思考响应兼容

独立 `reasoning_content`／`reasoning` 沿用原有通道。明确的 `content` 思考块单独分类：`type: thinking` 读取字符串 `thinking` 或其中的 `type: text` 子块，`type: reasoning` 只读取字符串 `text`；这些块的签名及其他原始字段不进入正文。`reasoning_details` 只将 `reasoning.text.text` 和 `reasoning.summary.summary` 作为可读思考；合法的密文、签名和未知类型完整保留。流式 detail 按 index、其次 id 合并；没有两者时保留分片，不凭数组位置猜测不同载荷属于同一条，也不按 index 重排收到的块序列。完整 message 快照替换协议聚合，不重复拼接密文与签名；无法协调的已交付正文／思考快照冲突仍明确失败。

损坏的可选 details 由 decoder 局部记录问题，继续解析同帧正文和其他合法思考；同一身份冲突的分片隔离，不强行合并。普通最终回复已有可用正文或思考时允许正常完成，只有损坏元数据而没有可读内容时仍失败。只要集合不完整，就不将剩余的部分 details 冒充完整协议回放；用户开启 HTTP 诊断时，原始响应与单独的 `protocolIssues`（类别、字段路径、帧号）一并保存，容错成功的记录保持 `error: null`。诊断默认关闭，不自动启用，问题记录不进入用户正文或请求体。

回放安全在模型回合成功终态前裁决。OpenRouter 及未知中转站若 details 损坏而响应要求工具续轮，明确失败，不交出可执行回合；完整未知对象可无损保留时照常回放。仅对已确认的官方地址使用独立契约：`api.deepseek.com` 有可信原生字符串思考或已明确关闭思考时，不依赖额外 details；`api.mistral.ai` 续轮依赖原始 content，按原载荷回传。第三方模型别名不继承官方豁免。不把先到的展示思考伪造成原生载荷，不编造签名、密文或身份。JSON／SSE、工具参数、无法协调的快照、服务商明确错误及取消继续走既有失败边界。

标签提取仅处理回答开头、可选空白后的精确小写 `<think>...</think>`。默认只为 DeepSeek R1／reasoner、QwQ、Qwen3（排除 Instruct／Coder／non-thinking）开启；其他接口可由明确知道其输出协议的装配方在 `AIClientConfig` 指定 `thinkTagMode: leading`，或用 off 停用。此选项仅控制响应分类，不发送给模型，不改用户的思考强度或模型设置。未知 Gemini／Claude 别名默认不套用标签协议。

开关标签可跨任意传输和 SSE delta 分片；未闭合的完整开标签后内容保留为思考，EOF 时不足以构成开标签的前缀仍作为正文。首段正文一旦开始，不再提取其中的标签；代码围栏、行内代码及 Markdown 缩进代码保持原文。不支持嵌套、大小写变体、`<thinking>` 或正文中再次出现的思考标签。已声明标签协议的接口若输出完全相同的裸标签示例，协议自身无法消除歧义；不应为这种接口开启提取。无标记 content 不做语义猜测。

一个流只选择第一个可读思考通道，同帧按原生字段、结构化块、details、标签的顺序选择，避免镜像通道重复展示。迟到的镜像字段不重新分类已经交付的事件；其原始协议载荷仍保留。相互矛盾的多个通道没有可证明的全局优先级，流式展示遵循先到通道，不承诺与一次性返回所有冲突字段时的优先级等价。

可读文本继续使用既有 `reasoning_delta`／`answer_delta`、ModelTurnCollector 和消息提交链。`reasoningReplay` 仅随现有本次执行的模型历史传递，在下一轮 HTTP 请求边界展开：标签／结构化块回放原始 content，details 回放其完整对象，原生思考存在时保留其原文。内部包装字段不发给服务商；不把加密数据变成展示文本，也不把结构化思考再次伪造为 reasoning_content。不新增表、持久化系统或历史聊天迁移。Fetch 与 Android XHR 共用同一 SSE parser，DONE 后停止事件交付，取消后不发布排队中的迟到事件；HTTP 诊断仍捕获解析前原文。

协议依据：[Mistral thinking 块](https://docs.mistral.ai/inference/conversations/reasoning)、[OpenRouter reasoning_details](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#reasoning-details-api-shape)。实现独立编写；只参考固定版本的 [Muse](https://github.com/Zer0Qing/Muse/tree/ae9d85664eb6e9188ca7e58ba6a8c67f9d79ccc4)／[RikkaHub](https://github.com/rikkahub/rikkahub/tree/14d60e44e730126fd8472a9906c17e6c1d798a40) 技术设计，没有复制 GPL／AGPL 实现或测试。

验证入口：`npm run verify:ai-reasoning-compatibility`，使用真实 Client、decoder、adapter 和 collector，模拟非流式、Fetch SSE、Android XHR SSE，覆盖可选元数据容错、冲突通道、标签分片、快照、取消及原始载荷工具续轮。HTTP 诊断的原文留存与问题记录由 `npm run verify:ai-http-diagnostics` 验证。

`disableThinking` 对已支持的可切换模型明确表达两端：`false` 开启思考，`true` 关闭思考。Qwen／百炼使用 `enable_thinking`，OpenRouter 使用 `reasoning.enabled`，其他兼容接口使用 `thinking.type: enabled / disabled`。已识别的可切换模型包括 Qwen3（排除固定思考、Instruct 与 Preview）、Qwen Plus/Flash/Turbo、DeepSeek V3.1/V3.2/V4、Kimi K2.5/K2.6 和 GLM 4.6/4.7/5/5.1/5.2；不能因百炼 Kimi 默认不思考而把开关关闭误解为省略参数。未提供开关的调用、未识别模型与非思考模型在未选择关闭时仍沿用服务商默认。连接测试、流式与非流式共用请求构造；不通过隐藏返回内容伪装关闭思考，不为关闭参数错误自动降级重试。固定思考模型或不同参数契约的自部署接口不保证支持该选择。

DeepSeek 官方接口默认启用思考。带工具请求在首次发送前为纯历史 assistant 正文补齐 `reasoning_content: ''`，表示该历史投影没有协议思考记录；已有思考（包括空串）原样保留。真实工具续轮由 Agent Runtime 回传模型思考，不用空格伪造，也不补写缺失的工具轮思考。此适配由 Provider 请求边界独占，无工具、关闭思考或其他接口不自动添加字段；账本与日程继续保持系统触发身份，不追加假的用户输入。协议依据见 [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)。

`reasoningEffort` 保存 `auto / minimal / low / medium / high / xhigh / max`，其中 auto 或未提供表示省略强度字段；它不等于关闭思考，也不是各模型通用的自适应模式。开关关闭优先于强度。`reasoning.ts` 独占能力识别与映射，普通、流式、工具请求和连接测试共用；不新增请求重试或按档位猜测 token 预算。页面展示所保存的统一偏好与当前模型实际强度，切换模型不丢失偏好。

直连 OpenAI 兼容协议使用 `reasoning_effort`；较弱偏好低于模型最小档时取最小档，较强偏好高于模型上限时取最高档。DeepSeek V4／Flash／Pro 按官方映射将 minimal/low 转为 low、medium/high/xhigh 转为 high、max 转为 max；GLM-5.2 将 minimal/low/medium/high 转为 high、xhigh/max 转为 max，避免 minimal 意外关闭思考；GLM-5.3 支持 low/high/max。Gemini 2.5 使用 low/medium/high，Gemini 3 Flash 支持 minimal/low/medium/high；Gemini 3 Pro 使用 low/high，Gemini 4 使用 low/medium/high，Hydrogen 另支持 xhigh。OpenRouter 发送 `reasoning.effort`，由路由服务换算；显式强度不与会隐含 medium 的 `reasoning.enabled: true` 混用。未确认支持强度的模型省略参数，不能将 Qwen 或 Kimi K2 的思考开关当成强度接口。

协议依据：[OpenAI 思考强度](https://developers.openai.com/api/docs/guides/reasoning)、[OpenRouter 推理参数](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)、[GLM 深度思考](https://docs.z.ai/guides/capabilities/thinking)、[Gemini OpenAI 兼容协议](https://ai.google.dev/gemini-api/docs/openai)。第三方中转或自部署接口仍须实现相应模型契约；客户端不自动删除被拒绝的强度参数重试。

纯历史补空是已验证的接口兼容行为，不恢复历史思考，也不代表服务商对所有型号的承诺。适用条件只由客户端请求构造判断，不向业务或 Agent 请求暴露修补开关，不根据错误文案补字段重试。工具续轮的真实思考（包括空串）在 complete、stream 与通话链路中原样传递，不做正文清洗；缺失时不制造占位，由服务端返回协议错误。这里仍是 OpenAI 兼容 Chat Completions 客户端，不声明支持其他厂商原生签名或 Responses 消息项协议。

## 依赖方向

- Feature 和 app 组合代码可以依赖 `@platform/ai`；
- `platform/ai` 不依赖任何业务 feature；
- 只有本目录内部可以直接导入具体 Provider 文件。
