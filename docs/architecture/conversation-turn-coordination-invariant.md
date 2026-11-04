# Conversation Turn 协调不变量

> Architecture Invariant
>
> 本文定义普通 Chat canonical `user_reply` 的回合所有权、固定输入区间和持久化提交边界。
> Android 后台宿主的生命周期细节见
> [`chat-background-execution-invariant.md`](./chat-background-execution-invariant.md)，commit 后交付见
> [`ai-message-delivery-invariant.md`](./ai-message-delivery-invariant.md)。

## 1. 适用范围

本文适用于 canonical 一对一会话中的 `user_reply` 及其显式 `regenerate`：

```text
用户消息
→ canonical commit
→ AI 回复执行
→ assistant 回合提交
```

群聊发言、Wallet assistant 回复、主动联系自身的路线决策以及 Calls 状态消息不属于
本文的 `user_reply` 输入。`metadata.type = 'callStatus'` 的通话状态气泡即使使用用户方向
展示，也不得推进普通 Chat 的回复游标、输入高水位或恢复条件。

旁路 writer 不得通过通用消息提交接口隐式 supersede `user_reply`。

## 2. Owner 与职责

Host 的 `ConversationTurnCoordinator` 裁决会话回合所有权：谁可以 claim、哪一轮仍有
提交资格，以及崩溃孤儿由谁接管。Chat Repository 持有 run、游标、revision 和 fence
事实；Agent Runtime 只负责一轮内部的模型与工具执行。

`databaseCoordinator` 只提供数据库调度和事务，不理解业务回合。`AbortSignal` 只用于
协作式停止和节省资源，不能作为提交正确性的依据。

AI 日程的 `autonomous` run 与普通回复、重写共用 `conversation_turn_state` 的唯一执行槽，
但不消费用户输入或推进回复游标。未领取的用户输入、重写意图及尚未完成的聊天交付均优先
于日程；日程背景持久交给正常聊天，不等待空闲后补跑。日程之间以最新计划时间优先，
同时间再按更新版本和稳定 ID 裁决；接管先撤销旧持久 fence，再取消其执行与展示。
只串行化短小的 admission 交接，不把模型、工具或交付放入等待队列。资格检查与自主 claim
仍在原事务完成，用户输入可在交接期间抢先获得执行权；迟到清理只移除自身句柄。
冷启动的旧展示记录沿既有展示恢复入口收口，Host 尚在注册展示的活动句柄必须一并保护。
日程不能为消化积压而启动普通聊天宿主。

新用户输入仍在原 T1 中撤销当前自主 owner，commit 后取消对应句柄。自主正文和过程消息的
每次提交都在消息事务内核对同一 run/revision fence，迟到结果不能越过新输入。
已经提交的行动不回滚。自主终态只释放自己的槽位；启动恢复只将无当前进程句柄的旧自主
run 标记为失败并释放，不重新执行模型或工具。自主 run 不参与普通回复的标题状态和失败覆盖查询。

T1 commit 后的 Host 适配先将被撤销及当前到期日程的背景交给正常聊天，再启动原聊天宿主。提示词
组装只读取已经交接的资料，不因一个迟到或取消的组装请求而终结新的任务。旧日程已经
consume 的竞态同样交接，不能靠它尚未执行 finally 来猜测。日程 Feature 以回合状态查询
确认结果是否已随 committed 回复交付；该查询不授予执行权，不改变 T1/T3。

## 3. 固定输入区间

每个 run 在 claim 事务中固定输入区间：

```text
(reply_cursor_at_claim, input_high_watermark]
```

- `reply_cursor_at_claim` 是 claim 时的当前回复游标；
- `input_high_watermark` 是同一事务中 canonical 用户消息的最大 id；
- 模型输入必须按 run 保存的固定上下界读取，执行中不得重新解释区间；
- 新用户消息 id 大于高水位时天然属于下一轮；
- 回复游标只能推进到本 run 的高水位，不得回退或越过它；
- 游标依赖 id 的提交顺序和大小比较，不依赖 id 连续无空洞。

显式重写用 `input_cursor_at_claim` 与原 `input_high_watermark` 固定原回合的输入区间，
`reply_cursor_at_claim` 仍是当前提交游标，供同一 T3 fence 比较。重写不回退游标、不新增
用户消息；连续重写继续继承原输入区间。当前模型配置与现存输入正文是重新生成的依据。

`chat_regeneration_requests` 每会话最多保存一个用户重写意图，包含源 run 和请求时的
revision。它没有独立执行队列、重试或 owner：页面写入意图后委派原 execution host，
同一个 T2 事务消费意图并取得 `regenerate` 的唯一 active run。菜单资格来自仓储真实
最新回复，不依赖分页列表。群聊、用户消息、旁路回复和存在后续用户输入的回合不具备资格。

## 4. 四类事务状态转换

### T1：canonical 用户消息提交

Chat application 的专用用户消息事务必须同时：

1. 确保会话存在 turn state；
2. 写入本次发送的全部 canonical 用户消息，图片与文字独立成行、整批原子提交；
3. 将已有 active run 标记为 `superseded`；
4. 清除旧 owner 并递增 revision。

T1 只服务 canonical 用户消息。assistant 消息、Calls 状态消息和其他旁路 writer 不得
借用它隐式取消 `user_reply`。事务 commit 后才更新投影并通知 Host 启动后续执行。

AI 图片下载引用、自身头像和自身表情维护的业务提交，也在各自事务里读取同一
`active_run_id + revision + run.status` fence。网络取消只负责节省资源；T1 已提交时，
取消信号即使尚未送到模型请求，旧回合也不能再提交这些副作用。已经提交的收藏、头像
或向量不因新消息回滚；未完成的 AI 处理 claim 被取消，失败/取消项只允许显式重试。

### T2：claim

普通发送和重复触发使用 `claimIfIdle`：仅在不存在 active run 时建立新 run，不抢走
正常执行中的 owner。恢复路径只有在当前进程不存在对应活动句柄时，才可使用
`takeOverOrphan` 在同一事务内 supersede 崩溃孤儿并建立新 run。

claim 必须写入固定输入区间、active run 身份和 claim 后 revision。数据库约束保证同一
会话最多一个 active run；关键 CAS 失败应暴露不变量错误，不得静默改写为普通失败。

普通输入的 failed／cancelled 终态覆盖检查与 claim 在同一事务完成；重复或迟到的宿主
请求不能重新领取相同输入。恢复扫描的预筛选只减少无效唤醒，不代替事务内资格裁决。

### T3：assistant 回合提交

同一回合 owner 区分“输出已提交”和“整轮已完成”。普通回复与自主回合的图片、表情在工具完成后，先经 `commitOutput` 的原 run/cursor/revision fence 提交消息、媒体引用和完整可见版本；不推进回复游标、不递增 revision、不释放执行槽，也不发出整轮完成回调。后续模型失败、取消或新输入只撤销未来输出，不回滚已经发送的媒体。

提前输出使用稳定 `clientMessageId` 和正式消息 ID，`turn_item_index` 暂为空。T3 根据时间线返回的 `committedMessageId` 将原消息绑定到最终顺序，不重新插入、不重放交付或通知；用户已经删除的输出不重建。这个空索引在完成前表示独立提交的输出，完成后才取得整轮候选归属。`regenerate` 不提前发送，仍保留完整替换的原子性；语音暂存物化也仍属于 T3。

T3 是 canonical assistant 回合的唯一终结提交点。一个事务必须同时：

- 校验 cursor、revision 和 active run 身份；
- 写入本轮其余 assistant、reasoning 和 tool timeline items，并绑定已提交输出的身份与最终顺序；
- 更新 session preview；
- 将 run 标记为 `committed`；
- 有正式 assistant 回复时按工具实际执行顺序保存本会话、本 AI 的工具包开关；
- 推进游标、清除 active run 并递增 revision。

`regenerate` 的 T3 在同一 fence 内先保存源回复候选，再删除源 run 的 canonical 条目（`turn_item_index`
非空），写入完整新回复并更新预览。关联业务卡片不属于这批
删除对象，工具已发生的业务效果保持不变，允许模型再次执行。媒体引用候选从删除
事务快照取得，提交后才交给 Media 裁决。页面隐藏是展示投影，不提前删除旧消息。
已有摘要与处理任务按产品契约保留，不因重写回滚或阻止执行。

fence 失败表示 run 已失去提交资格：本次事务不得写入任何 item、更新 preview 或推进游标，
也不得为旧 run 写错误气泡或自动重新提交。此前已成功提交的图片、表情保留；其余 canonical 正文不提前落库。

工具包状态随 T3 同事务提交；打开后持续保留，直到 AI 主动关闭，不按轮数到期。
同一包多次开关以最后一次成功操作为准；失败、取消、supersede、fence 失败和事务回滚不改变持久状态。
模型运行中的开关只修改 run 内暴露集合，下一次模型请求使用新的 schema，不提前持久化。
特批工具不受包开关影响；展开集合仍与本次授权相交，状态不能授予调用权限。
数据库 127 将旧三轮状态表清空重建，不保留临时展开选择；其他业务资料不受影响。

### 回复候选与单一时间线

`chat_reply_version_sets` 关联一轮的候选集合、当前承载 canonical 消息的 run、采用候选和永久锁定状态；
`chat_reply_versions` 只保存已成功提交的整轮消息快照，不建立第二条消息时间线或执行队列。
首次重写成功才创建集合，原回复与新回复同事务入档；再次重写沿用集合并更新当前 run。
候选 ID 表示内容来源，不授予历史 run 新的执行资格。

采用在同一个 Chat 事务内检查当前 run、采用候选 CAS、最新回合、后续锁定、执行和展示状态，
保存当前候选后替换 canonical 条目并更新预览。当前 run、原输入区间和回复游标不变，
revision 递增；原展示绑定随替换删除，采用的正文直接作为已读历史可见，不重新交付、通知或执行工具。
后续模型读取唯一 canonical 内容，候选表不参与上下文与摘要查询。手动改写同步当前候选快照及
已交付展示正文，不新增候选；摘要、记忆和已发生业务效果沿用既有不回滚契约。

用户输入或其他 run 的 AI 消息提交时，在同一消息事务内永久锁定已有候选；删除后续消息不解锁。
旁路 assistant 消息也撤销尚未完成的旧重写资格，防止迟到替换跨过已经发生的后续对话。
普通 `user_reply` 的执行 owner 不受这项旁路规则影响。

删除当前轮任一消息同时删除其候选，防止从存档复活已删除正文。清历史原子删除全部消息、候选及展示快照，并撤销旧 owner 与宿主请求资格；
删除会话级联删除整个集合。快照中的 metadata 以嵌套对象保存，Media 对其中资产执行统一的
引用枚举、释放裁决、备份和级联删除候选收集，不能在重写替换时释放仅剩历史引用的媒体。

### T4：revoke

真实取消或失败通过 expected revision 与 active run id 做 CAS，在同一事务内清除 owner、
递增 revision，并把 run 标记为 `cancelled` 或 `failed`。CAS 未命中表示 run 已经被
supersede、commit 或其他终态取代；不得重新改写 turn state。

`failed` 和 `cancelled` 是持久终态，启动恢复不得隐式重试其覆盖的同一输入区间。

## 5. Revision 不变量

revision 只在所有权或终态变化时递增，合法位置只有：

1. T1 用户消息 supersede；
2. T2 run claim；
3. T4 revoke；
4. T3 成功 commit；
5. 用户重写意图取得独立请求 revision；
6. 显式采用最新回合的另一个候选版本；
7. 清除全部聊天历史，撤销旧回合及迟到提交资格。

展示、通知、callback、AbortSignal 和普通读取不得修改 revision。

原生宿主启动失败只能撤销该请求 revision 或其直接 claim 的 run；迟到失败不得撤销
后来的重写。commit 后取消通知核对持久 active run 与捕获句柄，不能 abort 新 owner。

## 6. Execution Host

普通 Chat 页面不是可靠的后台执行宿主。唯一链路是：

```text
T1 user message commit
→ executionMode: delegate_to_android_host
→ Android-backed execution host
→ ApplicationExecutionHost → ExecuteConversationTurns（共享应用运行身份）
→ coordinator claim + execute，并等待 terminal
→ T3 assistant commit
→ AIMessageDeliveryCoordinator
```

页面不得直接 claim、执行模型或以 fire-and-forget Promise 持有回合，也不得在原生宿主
启动失败后回退到页面执行。待回复事实保留在持久游标和高水位中，交给后续宿主或恢复。

执行身份只由 `executionMode` 表达：

- `delegate_to_android_host`：当前调用者不是可靠的后台宿主，也是普通调用方的默认值；
- `inline_current_host`：当前调用者已经是受控宿主，并会等待 run 到达 terminal。

只有 RavenCat Floating Headless Task 等受控宿主可以显式选择 `inline_current_host`。
callback、AppState、调用栈或 React mounted 状态不得用来猜测 execution ownership。

## 7. 启动恢复与防隐式 retry

启动或回前台恢复只分页发现待回复会话并启动 Android execution host，不在页面 runtime
claim 或执行，也不建立第二份 pending message queue。Headless 任务按会话串行完成
claim、孤儿接管、模型执行和 T3/T4，持续等待每个 run 到达 terminal。

当前进程已有活动句柄时跳过该会话；没有对应句柄的持久 active run 才视为崩溃孤儿。
恢复不得自动重试 fence-failed、failed 或 cancelled 覆盖的区间。只有新用户消息扩大
高水位、用户显式重试，或具体工具拥有专用幂等策略时，才可建立新的执行资格。

不得通过 cooldown、sleep、重复 callback 过滤、多层 retry 或第二份队列掩盖竞态。

重写意图也通过原扫描入口委派宿主；已开始的 `regenerate` 崩溃孤儿只撤销资格并恢复
旧回复，不隐式重跑工具。失败、空回复和取消不删除源回复。新用户输入、手动编辑、
删除与清历史在各自原事务内撤销重写资格，commit 后才 abort 活句柄和刷新 UI。

## 8. Commit 后交付

完整正文展示版本持久发布后，以及 T3 commit 后新物化的媒体消息，其通知、前台抑制和 RavenCat overlay preview 统一由
`AIMessageDeliveryCoordinator` 裁决。页面、Host、RavenCat 和通知模块不得分别维护
第二套判定；delivery callback 只表达投影和交付观察，不表达 execution ownership。

完整正文按稳定气泡身份逐条通知，不等待整轮工具结束；图片、表情随工具输出的正式提交立即交付。T3 独占回复游标推进与整轮终结，已经交付的正文或媒体不重复通知。

UI、通知或 overlay 展示失败不得回滚已经提交的 Chat 事实。

## 9. 事务边界

T1～T4 事务内只允许 SQL、row/entity mapping、短小纯计算和不变量检查。模型、网络、
文件 IO、Android 原生调用、通知、TTS/ASR、timer、event subscriber、跨 Feature 发布和
其他业务队列都必须发生在 commit 之后。

## 10. 永久约束摘要

- canonical `user_reply` 只有一个产品级回合 owner；
- 每个 run 使用固定输入区间；
- active run 由持久事实、CAS 和数据库约束保护；
- 每次输出或 T3 fence 失败均不产生该次提交的部分事实，先前已提交输出保持有效；
- 页面不拥有普通 Chat 的后台执行生命周期；
- recovery 只发现并委派，execution host 才 claim 和执行；
- failed、cancelled 和 fence-failed 不被隐式 retry；
- delivery 不拥有 execution；
- AbortSignal 只节省资源，不决定正确性；
- 不建立第二份 pending message queue。
