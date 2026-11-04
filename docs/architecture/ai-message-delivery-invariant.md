# AI 回复执行宿主与消息交付

持续前台保障由应用独立总开关控制，聊天和日程不再逐条启停通用保活服务。执行宿主仍负责本次任务的等待、取消与提交资格，见 [应用后台运行](./application-background-runtime.md)。

Host 在业务查询前通过 `ensureHostDatabaseReady()` 完成恢复事务门与普通数据库 bootstrap。普通 Chat、Calls 执行/拒接与 Together 通知动作共用该门；没有恢复任务也必须等待初始化。Repository 信任 Host 启动契约，不自行重复初始化。


执行生命周期与展示生命周期解耦：

- 任何要求在 Activity 不可见后仍继续完成的 AI run，不得由页面 React runtime 的
  fire-and-forget Promise 独占执行生命周期；必须由具备 Android 后台生命周期保证的
  execution host 承担（Activity 不可见后，页面 JS runtime 的 XHR/SSE 消费可能被冻结）。
- 普通聊天 canonical `user_reply` 的唯一执行宿主是
  `ApplicationExecutionHost` 内的 `ExecuteConversationTurns`
  （与所有业务共用一个应用 RN 后台身份）：页面在 T1 commit 后只 abort 被 supersede 的旧句柄并
  `startConversationTurnExecutionHost`，不得在页面 runtime 直接 claim；
  任务侧经 `ConversationTurnCoordinator.executeTurnFromHost` claim 并等待 run 到达
  terminal，执行链路仍是 `executeUserReplyTurn → processAIReply`，禁止复制回复业务流程。
- execution ownership 必须由显式 `executionMode` 表达：普通 Chat page 默认
  `delegate_to_android_host`；仅受控且会等待 terminal 的 execution host（如 RavenCat
  `executeFloatingMessage`）可显式选择 `inline_current_host` 并就地 claim + 执行。
  `replyCallbacks` 仅用于回复投影/交付观察，不得用于判定 host 身份。
- 后台执行一律 `deliveryTiming: 'immediate'`（后台 setTimeout 会被冻结）。
- 不新增第二份 pending queue、JS 轮询、回前台补跑、多层 retry 或页面保活 hack；
  跨进程正确性以持久化 fence / watermark / revision 为准，AbortSignal 只节约资源。
- 启动恢复（recoverConversationTurns）同样只负责发现待恢复会话并启动
  execution host，不得在页面 runtime claim/执行恢复出的 run；多个恢复会话在
  同一次应用宿主请求内串行执行，孤儿接管与终态覆盖判定由 executeTurnFromHost 承担。
- assistant 消息持久交付后的判定统一在 `AIMessageDeliveryCoordinator`
  （每个 JS runtime 注册一次）：前台正在查看的会话抑制系统通知（已读由 Host UI 同序完成），
  其余走 Native NotificationManager 聚合通知，`userNotificationHandled` 尊重
  RavenCat overlay preview 消费者；Chat 页面 / KimiPhoneHost / RavenCat / 通知模块
  不得各自维护一套「回复来了怎么办」的判定。
- 普通正文在完整气泡的展示版本持久发布后立即交付通知，不等待工具循环结束或 T3。
  流式活动尾泡只更新展示，闭合或本次模型发言结束才通知；reasoning/tool 不发消息通知。
  通知使用稳定 `clientMessageId`，不伪造正式消息 ID；T3 继续原子提交整轮，
  对已经交付的正文只完成 canonical 投影回调，不重复系统通知。图片、表情在工具完成后
  经同一回合 owner 的输出事务取得正式消息、媒体引用与可见版本，随后立即交付；不等待续轮。
  T3 只绑定已经发送的媒体身份，不重放分段回调或系统通知。语音和重写媒体仍在 T3 后交付。
  中断或恢复不会补发未闭合正文，也不重放已发送媒体。
  悬浮预览通过运行正文投影回执表达已展示，统一协调器继续尊重
  `userNotificationHandled`；正式身份交接不得重复弹出预览。
- canonical 正文仍在 T3 一次提交全部分段，并绑定已提交媒体的最终顺序。运行片段在独立展示表中保存快照，
  不作为正式 assistant 消息、回复游标或工具重放依据。非流式正文使用原生约 1 秒
  到达时钟；流式正文按持久批次逐步交付并在自然边界继续下一泡，后续 reasoning/tool
  不等待正文。T3 绑定稳定片段身份，不重播已到达片段。
  持久交付、UI 绘制和 T3 是不同事实，界面展示前必须先保存交付版本；折叠过程卡片
  不得阻止存档或让完成状态挂起。新用户输入在原 T1 内一次放行已经通过 T3 的剩余
  分段；仍在执行的 run 只保留已交付过程。超时及 runtime 销毁不得通过清空内存
  pending 开放消息，冷启动由持久交付事实恢复；不渲染交付占位或中断替代气泡。
  具体边界见 [Chat 展示与中断历史](./chat-turn-presentation-invariant.md)。
- Tab、会话红点与实时列表预览查询排除尚未到达的消息 ID，非流式多气泡聊天页
  消费同一进度，不再单独计时。未读统计合并正式消息与尚未绑定正式 ID 的完整交付正文，
  两者分别使用各自持久 `is_read`，同一身份只计一次。进入会话在同一事务标记两种事实；
  T3 在消息提交事务继承运行正文的已读状态，
  后续分段到达不得重新制造未读。展示查询不得回写 session/group 持久预览。
  会话列表预览同时读取已持久交付的完整运行正文，不能因尚未 T3 而停留在旧消息；
  活动尾泡、思考和工具过程不抢占摘要。正式消息与运行正文在同一 SQLite 快照中选择，
  清空历史和后续用户输入继续生效；预览返回文字与时间，不伪造消息 ID。
  读取期间收到新的正文交付，即使 canonical 到达版本未改变，也须作废旧预览并合并补读。
- 回合诊断统一用 `@shared/diagnostics/TurnTimelineLog` 的里程碑事件
  （runId / correlationId 串联），禁止输出 prompt、key 与消息正文。

ConversationTurn 的固定输入区间、事务状态转换与提交 fence 见
[`conversation-turn-coordination-invariant.md`](./conversation-turn-coordination-invariant.md)。

用户任命／撤销主理 AI 的即时回应由 `executeHostRelationshipReply` 在同一个应用宿主中等待本轮执行，等待 Chat 的 `requestProactiveChatReply` 到达终态。关系事实先提交，操作通知仅作为本轮模型输入，不伪造 canonical 用户消息，不推进 `user_reply` 游标，不在设置页执行模型。实际 assistant 消息继续经过本文件的统一交付协调器。该即时沟通不建立新的持久恢复队列，也不因回复失败回滚身份变更。

### Protected Chat Background Execution Contract

普通 Chat AI 回复的执行生命周期必须由 Android-backed execution host 持有，不得退回页面
React Native runtime。

修改 `SendUserMessage`、`ConversationTurnCoordinator`、`ConversationTurnExecutionHost`、
`ExecuteConversationTurns`、reply callbacks 或相关 wiring 前，必须阅读：

`docs/architecture/chat-background-execution-invariant.md`

不得以 slimming、callback unification、fallback、runtime simplification 等理由绕过该约束。
