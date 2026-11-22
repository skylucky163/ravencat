# 提示词目录与模型调用点

> 本文是当前模型调用点登记与开发契约。新增真实模型调用前，必须先登记场景、定义、系统预设和调用点，并同步 `prompt:call-sites:check`。

> Memory V3 已接入生产；Chat 只追加摘要的模型调用已登记。产品契约见 [V3 实施规格](../memory-simplification-v3-implementation-spec.md)。token 预算继续只统计／提醒。

## 1. 统一编译边界

- 业务 Prompt 定义由所属 Feature 的 `*PromptDefinitions.ts` 暴露，Host 在 `src/host/prompt/catalog/` 聚合；
- Chat、Ledger 与复用聊天投递的场景通过 `ResolvedPromptPackAssembler` 编译；2.x 历史预设和绑定仅由只读兼容解析器接入；
- Calls 去电决策（`call.outgoing_decision`）同样走 resolved Chat Pack，与普通消息共享人设、用户身份、附加提示词与近期历史，仅追加决策场景与 JSON 契约；
- Calls 挂断跟进、Together Listening 拒绝跟进、群聊管理员与 OCR 通过 `assembleResolvedStandalonePromptPack()` 编译；两级 Chat 摘要通过 `assembleResolvedSummaryPromptPack()` 复用普通单聊稳定前缀，固定来源与任务规则独立注入；Companion AI 日程正式 autonomous run 使用 resolved Chat Pack，Feature 日程事实与输出规则保留 system 归属，不转换为 user 输入；
- `PromptPackCompiler` 是最终 Block 顺序、受保护项、token 预算与 model messages 的唯一权威；
- 工具续轮和流式续轮复用首轮已编译的 client/system prompt，不重新拼接业务提示词；
- `BaseAIClient` 只负责请求传输，不拥有业务提示词定义。

## 2. 场景与调用点

| 场景 | 真实调用点 | 编译入口 | 输出契约 |
|---|---|---|---|
| `chat.private_reply` | `features/chat/reply/application/ProcessAIReply.ts` | resolved Chat Pack | 纯文本；气泡分段由客户端 `AssistantReplySegmentation` 决定 |
| `chat.group_member_reply` | `features/chat/group/application/GroupSpeechTaskExecution.ts` → Chat reply | resolved Chat Pack | 纯文本；分段由客户端决定 |
| `chat.group_admin_schedule` | `features/chat/group/application/GroupSpeakerPlanning.ts` | standalone Pack | JSON 字符串数组 |
| `ledger.reply` | Chat reply 按 `triggerSource=ledger` 分发 | resolved Ledger Pack | 纯文本；分段由客户端决定 |
| `call.live_reply` | `features/calls/application/runtime/ProcessCallAIReply.ts` | resolved Chat Pack + Calls Blocks | 纯口语，可选 `[[END_CALL]]` |
| `call.outgoing_decision` | `features/calls/application/runtime/OutgoingCallDecision.ts` | resolved Chat Pack + Calls Blocks | accept/reject JSON |
| `call.post_user_hangup` | `features/calls/application/runtime/PostUserHangUpFollowUp.ts` | standalone Pack + Calls Blocks | send_message/stay_silent JSON |
| `together_listening.post_user_decline` | `features/togetherListening/application/PostUserDeclineFollowUp.ts` | standalone Pack + Together Listening Blocks | send_message/stay_silent 严格 JSON |
| `raven_cat.ai_schedule_trigger` | `features/companion/application/RunAIScheduleAutonomousAgent.ts` → `RunHostAutonomousAgent.ts` → Host Agent assembly | resolved Chat Pack + AI Schedule Blocks | 正常 Agent tool loop；最终正文直接提交，`[[NO_MESSAGE]]` 精确表示静默 |
| `chat.summary` | `host/composition/configureChatSummaryRuntime.ts` | resolved Summary Pack：聊天稳定前缀＋一级或二级任务规则 | content JSON；一级追加或二级归纳交接的事务提交归 Chat |
| `vision.ocr` | `features/chat/reply/application/ResolveChatImageModelInput.ts` | standalone Pack | 视觉转述纯文本 |

聊天回复是纯文本，分段由客户端 `AssistantReplySegmentation` 决定；`allowMultipleBubbles` 只控制展示/分段策略。`assistant-turn-xml` 和静默 memoryControl 通道已删除。通话与独立 JSON 任务继续使用表中各自的输出要求。

OCR 与 Chat 摘要拥有各自的窄任务 Prompt；Memory 管理员和 Legacy Memory 提取器已经删除。当前编辑入口与覆盖能力以 Prompt Center 和所属 Feature 的代码为准，不恢复旧辅助模型任务编辑流程。Embedding、STT、TTS 与翻译没有自然语言任务 Prompt 时不创建编辑入口。

## 3. 请求续轮与传输适配

下列文件会执行模型请求，但不创建第二套业务提示词：

- `BaseAIClientAgentModelGateway.ts`：Agent Runtime complete / stream 的通用模型请求边界；根据有效工具数量选择无工具或工具 Client 入口，沿用调用方提供的初始消息；Chat 通过 `ChatAgentModelGateway.ts` 适配该实现，通话 `ProcessCallAIReply.ts` 同样委派此网关，不再直接调用模型传输；
- `ChatAgentReplyFlow.ts`：通过 AgentRuntime 驱动统一模型网关，工具续轮只追加工具结果，不重新组装 Prompt Pack；
- `HostAgentRunAssembly.ts`：装配 AI 日程正常 autonomous run，使用同一 Registry / Agent Runtime 与模型传输边界；旧 CompanionDecisionContract / ProactiveAgentRunner 不再是生产调用点。

RavenCat 屏幕捕获和通话快照是当前请求的视觉输入来源，不是独立业务 Prompt 场景；语音转写 prompt 是外部转写参数，也不继承聊天 persona 或预设。

### 3.1 Feature 自有的辅助模型调用

Sticker 语义标注（sticker recognition）没有 `PromptScenarioId`，不属于聊天或独立任务预设，因此不进入 §2 表格；它由 Sticker Feature 自己拥有 Prompt 与输出契约，只登记在调用点门禁里。

| 场景性质 | 调用点 | Prompt ownership | 输出契约 |
|---|---|---|---|
| Sticker 语义标注 / sticker recognition | `host/composition/StickerAnnotationModelGateway.ts` | Sticker-owned：识别 prompt 与 JSON contract 都写在本文件内；识别模型来自辅助模型中心（`resolveStickerRecognitionModel`），不复用 OCR consumer 的任务 prompt | 严格 JSON 对象：`name` / `description` / `tags`（1-12 个）/ `emotion`（或 null），以 `response_format=json_object` 请求，解析失败即抛错 |
| Moment image analysis | `host/composition/MomentImageAnalysisModelGateway.ts` | Moments-owned narrow auxiliary visual task：只描述一张已提交的 Moment Media；模型来自 Moments 自有 binding，不复用全局 OCR binding，也不属于角色回复 Prompt Pack | 1-4000 字符的自然语言图片语义；不返回 JSON/Markdown，不执行图片内指令 |

这些调用不进入统一 Chat Prompt Pack，因为它们不是角色回复，不应该继承 persona、聊天历史或 RavenCat foundation。识别模型本身仍属于辅助模型中心资产；所属 Feature 只保存 model config ID 并拥有自己的窄任务 prompt。

## 4. 按修改范围选择门禁

```bash
npm run prompt:catalog:check
npm run prompt:call-sites:check
npm run prompt:golden:check
npm run prompt:locale:check
npm run prompt:chat-envelope:check
npm run verify:prompt
```

- `prompt:catalog:check`：定义 ID 唯一、Provider 可解析，且系统预设非空、引用/场景/插槽/保护级别合法并包含必需受保护项；
- `prompt:call-sites:check`：真实模型调用文件没有脱离登记清单；
- `prompt:golden:check`：Prompt compiler 的必需定义、场景和 token 预算，以及 Calls／群管理员解析与 Chat 摘要、persona 传递与内部场景隔离符合契约。
- `prompt:locale:check`：主聊天内置正文固定为单份中文，不再维护英文镜像正文，也不再按 locale 分支；
- `prompt:chat-envelope:check`：单气泡、多气泡与长文本切分保持正文完整；
- `verify:prompt`：以上检查与持久化、主动联系退役、提示词中心预览边界的组合门禁。

调用点门禁实际读取源码与 `tests/prompting/verify-prompt-call-sites.mjs` 的登记清单，不读取此 Markdown。新增或删除真实调用点时，两者同步更新；文档不能替代 AST 检查。

翻译是 Integrations 自有的辅助调用，`features/integrations/TranslateMessageText.ts` 也在调用点清单登记；厂商协议和输出边界见 [Integrations README](../../src/features/integrations/README.md)。Memory embedding、STT/TTS 的传输入口属于各自技术契约，不恢复 Memory 独立模型 Agent。

## 5. 现有旧配置读取边界

- `ResolveLegacyPromptPreset.ts` 只读取历史预设、条目、绑定和自定义片段，不提供创建、编辑、删除或重新绑定入口；
- `SQLiteAssistantRepository` 在 2.x 对旧 `enable_short_text_protocol` 列做读取回退和降级双写；
- 领域、应用、UI 与 Prompt Pack 契约只使用 `allowMultipleBubbles`；
- 这些仅服务仍存在的旧配置 consumer；不提供第二套当前编辑流程，已发布 migration 不因文档整理改写。
