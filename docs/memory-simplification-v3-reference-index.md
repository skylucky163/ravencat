# Memory V3 当前实现索引

> 产品规则见 [当前契约](./memory-simplification-v3-implementation-spec.md)，入口与验证边界见 [Memory README](../src/features/memory/README.md)。
>
> 核对日期：2026-10-11。以下路径均为当前代码，不保留旧设计文件的待施工清单。

## 1. Memory

下表路径相对 src/features/memory/。

| 路径 | 所有权 |
|---|---|
| domain/Memory.ts | 正文非空／摘要50字边界、规范化、lexical／vector-only 两组排序、稳定 DTO |
| domain/MemoryRepository.ts | 正文／触发关系／embedding 持久化 port |
| domain/MemoryPoolRepository.ts、infrastructure/SQLiteMemoryRepository.ts | AI×用户 pool |
| application/MemoryCommands.ts、MemoryQueries.ts | 用户命令、空间选择、召回设置、管理查询 |
| application/RecallMemory.ts | run 内固定正文／排序／分页队列与语义不可用诊断 |
| application/MemoryEmbeddingWorker.ts | 模型同步、claim 后事务外请求、有界失败与取消 |
| application/MemoryRuntimeDependencies.ts、MemorySignals.ts | 外部模型 port、commit 后信号 |
| infrastructure/SQLiteMemoryEntryRepository.ts | scoped SQL、收据、原子 claim／revision／模型 CAS |
| aiTools/MemoryAgentTools.ts | remember／recall／update／forget 的 Agent-native 契约 |
| presentation/MemoryScreen.tsx、MemoryEditorScreen.tsx、memoryScreenStyles.ts | 扁平 UI、正文编辑、trigger 开关、数量及向量详情 |
| presentation/MemorySpacePanel.tsx、MemoryTriggerScreen.tsx | 多词／多记忆关联组创建、词集合与组规则编辑、组内记忆开关 |
| index.ts、composition.ts | 稳定 facade 与 Host-only 装配出口 |

## 2. Chat 与 Prompt

| 路径 | 所有权 |
|---|---|
| src/features/chat/summary/domain/ChatContext.ts | 摘要计数与 raw 共用正文投影、canonical cursor |
| src/features/chat/summary/domain/ChatSummaryRepository.ts | 用户摘要、处理状态及追加 claim port |
| src/features/chat/summary/application/ChatSummary.ts、ChatSummaryPrompt.ts | 用户维护、AI 只追加、固定日期锚点及输出边界 |
| src/features/chat/summary/infrastructure/SQLiteChatSummaryRepository.ts | 摘要／watermark 原子交接，用户清空 generation fence |
| src/features/chat/summary/presentation/ChatSummaryScreen.tsx | 聊天菜单中的摘要管理 |
| src/features/chat/messages/infrastructure/ChatTimelineSql.ts | 消息与摘要共同使用的 canonical SQL 排序 |
| src/host/prompt/PromptHistoryBuilder.ts | 摘要＋未总结 raw，保护 Current Input，保留 Calls 上下文 |
| src/host/prompt/PromptPackBlockFactory.ts、PromptPackAssembler.ts | 本次输入被动召回、旧预设固定上下文接入 |
| src/host/prompt/compiler/PromptPackCompiler.ts、systemPromptPresets.ts | 稳定摘要前缀；token 只统计／提醒 |
| src/host/prompt/catalog/、providers/、src/shared/prompt/ | passive／chat.summary 当前目录、场景与 Provider |

## 3. Host 与技术底座

| 路径 | 所有权 |
|---|---|
| src/host/composition/configureMemoryRuntime.ts、configureChatSummaryRuntime.ts | 仓储与模型装配，摘要复用该 AI 聊天模型 |
| src/host/application/TransferProtocolToMemory.ts | 协议到记忆的单向原子转存，commit 后刷新，快照冲突拒绝 |
| src/host/composition/agent/createAgentToolRegistry.ts、HostAgentRunAssembly.ts | 唯一工具注册、授权与 run 终态清理 |
| src/host/runtime/MemoryEmbeddingQueueCoordinator.ts、ChatSummaryQueueCoordinator.ts | 前台空闲调度、取消、有限 retry 唤醒 |
| src/host/KimiPhoneHost.tsx、composition/createBackupRuntime.ts | bootstrap 门与 reset／restore quiesce |
| src/platform/persistence/sqlite/memoryV3Schema.ts、chatSummarySchema.ts、migrations.ts | 当前物理表、排序锚点、117 关联组迁移与版本事务；旧摘要迁移 helper 仅用于局部验证 |
| src/features/memory/application/MemoryEmbeddingModels.ts、src/features/assistants/ResolveAuxiliaryModel.ts、AuxiliaryModelsChanged.ts | Memory 明确向量选择、模型资产解析与 commit 后变更信号 |
| src/platform/ai/BaseAIClient.ts、types.ts | embedding 网络／响应错误分类与取消边界 |
| src/app/memory/index.tsx、settings.tsx | 当前 Memory UI／全局 embedding 配置路由 |

旧树、管理员、草稿、来源、粘连、胶囊、F7 代码与其专项 verifier 已删除。历史 SQL 保持原样，通用模型资产保留；生产不存在新旧双写。

## 4. 验证

- tests/memory/verify-memory-v3.mjs：隔离 SQLite 的正文、权限、关联组多对多／同名词／独立开关、分页、CAS、失败预算、摘要交接与升级／快照行为。
- tests/memory/verify-memory-v3-prompt.mjs：真实 Prompt 组装、旧预设、稳定前缀、完整原文／正文、Current Input 与 Calls。
- tests/helpers/chat-timeline-fixture.mjs：小型 Chat 仓储用例装配真实 canonical anchor schema。
- npm run verify:memory：以上两组 V3 行为验证入口。

真实模型、设备 UI 与 Android 原生恢复需独立验收，隔离 SQLite 和 Prompt 验证不能替代这些场景。
