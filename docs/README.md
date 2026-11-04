# 文档导航

使用条件与源码入门见[项目介绍](../README.md)，本地环境、开发安装和调试见[开发指南](development.md)。修改代码前阅读 [AGENTS.md](../AGENTS.md)，只运行与修改范围相关的验证。

## 定位代码

- [架构导航](architecture-navigation.md)：源码分层、导航所有权与依赖方向。
- [架构快照](architecture-snapshot.md)：由脚本生成的源码文件树。
- 各 Feature 的 README：当前入口、目录、公共能力与定向验证。

## 架构与产品契约

| 领域 | 阅读入口 |
| --- | --- |
| Chat | [Feature README](../src/features/chat/README.md)、[模块边界](architecture/chat-module.md) |
| 回合与后台执行 | [回合协调](architecture/conversation-turn-coordination-invariant.md)、[后台执行](architecture/chat-background-execution-invariant.md)、[消息交付](architecture/ai-message-delivery-invariant.md) |
| Prompt | [默认组装](prompt/default-prompt-assembly.md)、[模型调用点](prompt/prompt-model-call-sites.md)、[主客窗口](prompt/context-window-primary-secondary-design.md) |
| 模型与设置 | [辅助模型选择](architecture/auxiliary-model-selection.md)、[模型自动保存](architecture/model-settings-autosave.md)、[对话信息自动保存](architecture/conversation-settings-autosave.md) |
| Memory 与摘要 | [当前契约](memory-simplification-v3-implementation-spec.md)、[代码索引](memory-simplification-v3-reference-index.md) |
| 通话 | [Calls README](../src/features/calls/README.md)、[架构](ai-video-call/architecture.md)、[原生执行与验收](ai-video-call/native-call-implementation-checklist.md) |
| 主动伴随、手机与悬浮能力 | [能力文档导航](ravencat/README.md) |
| 时刻 | [产品与架构契约](moment/ravencat-moments-v2-architecture-draft.md) |
| 表情包 | [Feature README](../src/features/stickers/README.md)、[模型与检索契约](sticker-system-v2-implementation-plan.md) |
| Agent Runtime | [执行内核契约](KimiPhone-agent-runtime-foundation-implementation-plan.md) |
| MCP | [聊天注入契约](architecture/mcp-chat-injection.md)、[Feature README](../src/features/mcpTools/README.md) |
| SQLite | [并发与事务契约](sqlite-concurrency-architecture-requirements.md)、[平台入口](../src/platform/persistence/README.md) |
| 媒体 | [资产与生命周期契约](ravencat-media-asset-refactor-plan.md) |
| 备份恢复 | [格式与恢复事务](backup-and-restore-implementation-plan.md)、[Feature README](../src/features/backup/README.md) |

部分专项文件沿用原路径以保持代码、脚本与 README 引用稳定，正文描述当前契约，不作为实施路线图。自动化验证不能替代 Android 后台、OEM、真实模型服务和跨设备恢复验收；相关边界在各专项文档说明。

## 实施规划

当前实施记录：[AI 个人主页布局与设置归属](assistant-profile-settings-migration-plan.md)，包含资料卡、共用上下文页、共用摘要页和验收范围；流式与多气泡保留现状；更多菜单保留现有结构。该文区分规划与已实现行为，不替代当前架构契约。

## 来源与许可

- [MIT 中文说明](license-options.md)与[正式许可证](../LICENSE)。
- [素材来源](asset-sources.md)。
- [第三方软件声明](third-party-notices.md)，包括依赖清单、参考实现、许可原文和当前收集缺口。
