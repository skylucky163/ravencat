# Chat 模块当前架构契约

> 状态：**CURRENT ARCHITECTURE CONTRACT**
>
> 本文描述 Chat 的长期 ownership、公共边界、回复执行链与消息语义。历史 Phase A～H 迁移 checklist 已移除；当前目录入口另见 `src/features/chat/README.md`。

## 1. 四层边界

Chat 对外分为四个不同层次：

```text
Chat Public API
= 其他 Feature / App 可以调用的稳定 command、query、DTO 与 presentation entry

Chat Public Facts
= 其他 owner 可以订阅的最小 post-commit 事实

Chat Internal Engine
= reply、persistence、timeline、group messaging 等内部实现

Chat Host Composition
= 具体 repository、runtime dependency、执行入口与跨 Feature 装配
```

外部模块只能从 `@features/chat` 使用普通公共能力；只有 Host 可以从 `@features/chat/composition` 取得装配能力。不得跨过 facade 深导入 Chat 内部目录。

## 2. Chat 拥有消息语义

Chat 负责：

- 单聊与群聊的 message / conversation identity；
- user、assistant、reasoning、system 与结构化 metadata 语义；
- optimistic user message 与 canonical commit；
- timeline ordering、分页、stateful entry patch；
- conversation preview 与 read state；
- reply policy、assistant turn commit 与 delivery request；
- Chat presentation 对稳定消息模型的投影。

外部 Feature 不得直接写 Chat repository、拼接 message row、更新 conversation preview 或手动发布 UI refresh。需要向 Chat 写入内容时，必须调用完整 command，例如 external assistant message、stateful timeline entry 或 proactive reply entry。

Chat 的业务 SQL 留在 Chat infrastructure adapter；连接、schema、migration 与单写者调度仍由 `@platform/persistence` 拥有。

## 3. Chat 不拥有的能力

Chat 不拥有：

- AI provider、HTTP 或流式传输底座；
- Agent Runtime 的通用 task / run / tool execution；
- Memory 摄取与记忆业务；
- Calls、Together Listening、Companion 等 Feature 的领域状态；
- Android execution host、通知平台或应用级生命周期；
- 跨 Feature 具体实现装配。

Chat 可以通过 application port 请求这些能力，也可以投影外部 Feature 的稳定事实，但不得把外部领域状态复制成第二套 truth。

## 4. Public API

`src/features/chat/index.ts` 只暴露外部调用方真正需要的稳定能力：

- conversation / message / group command；
- query 与稳定 DTO；
- assistant delivery fact 的订阅入口；
- `ChatScreen`、底部导航和路由所需 presentation entry。

普通出口禁止暴露：

- concrete Repository / SQLite adapter；
- `configure*`、runtime setter 或 publisher；
- `ProcessAIReply`、reply turn 与 projector；
- 内部 event emitter；
- 只为测试存在的实现细节。

Public command 必须完成自己的完整职责，包括事务提交、Chat 内 preview / cache / UI 更新，以及 commit 后需要请求的 delivery。调用方不应重复这些步骤。

## 5. Public Facts

Public fact 表达已经提交的稳定事实，而不是“请替 Chat 完成剩余工作”的半成品事件。

```text
transaction commit
→ Chat 自己完成 preview / UI / delivery request
→ publish narrow public fact
→ 外部 consumer 处理自己的派生业务
```

Public fact payload 只包含 consumer 真正需要的稳定 identity 与 DTO，不暴露 repository、transaction handle 或内部 orchestration helper。

没有真实 consumer 的历史事件应删除，不为假想未来维持广播契约。

## 6. Host Composition

`src/features/chat/composition.ts` 是 Host-only integration facade，负责：

- 装配 Chat 的 concrete repository；
- 注入 Agent Runtime、AI gateway、Calls gateway 与 delivery handler；
- 提供 Android execution host 所需的回复执行入口；
- 组合跨 Feature prompt blocks 与 runtime dependencies。

Host composition 不改变业务 ownership。具体实现能在 Host 中接线，不代表 Host 或 Agent Runtime 拥有 message lifecycle。

## 7. 用户消息与回复主链

单聊「手动召唤回复」默认开启。文字、图片、文件、表情包与语音继续由同一个用户消息提交入口保存，T1 在消息事务中同时写入 `reply_requested`；手动发送不授权回复，重启扫描和迟到宿主请求也不得将其自动执行。关闭开关恢复提交后自动请求。群聊固定手动召唤，没有偏好入口和自动请求计时器。

显式召唤持久登记 `summon_requested`，由原 Android execution host claim 为 `summon` 回合，复用消息组装、Agent Runtime、T3 和交付。存在未回复输入时固定整批区间；没有新输入时仅把用户点击按钮、希望 AI 主动陪伴的意图加入本轮模型输入，不新增用户消息。续聊不推进已消费输入游标，展示锚点固定在召唤时的时间线位置；重复点击不建立第二个 owner。失败／取消与已开始召唤的崩溃孤儿不自动重放，用户下一次明确召唤可重新授权。

```text
presentation
→ sendUserMessage
→ canonical user commit
→ commit 后请求 Android execution host
→ executeUserReplyTurn
→ ProcessAIReply
→ ChatAgentReplyFlow
→ Agent Runtime
→ AssistantTurnCommit
→ Chat 更新 preview / UI
→ assistant delivery coordinator
```

Android execution host 负责进程与后台执行存活；Agent Runtime 负责模型与工具循环；Chat 负责 user/assistant message semantics 和最终 commit。三者不得互相复制流程。

外部 assistant message 通过独立 Chat command 进入，同样由 Chat 完成 persistence、preview、UI 与 delivery，不允许调用方逐步拼装。

## 8. Agent Runtime 不拥有 Chat lifecycle

Agent Runtime 的通用职责是：

```text
task input
→ model request
→ optional tool loop
→ structured run outcome
```

Chat adapter 把 conversation、prompt、tool authority 和 message history 投影为 Agent task，再把 run outcome 提交成 Chat message。Agent Runtime 不得直接：

- 创建或更新 ChatMessage；
- 决定 conversation preview；
- 发布 Chat UI 事件；
- 决定 foreground suppression / notification delivery；
- 持有 Chat retry、resume 或 cancellation 的业务语义。

## 9. Reply policy 正交性

以下概念必须分开：

```text
transport
= complete / stream，以及模型与工具交互的传输能力

tools capability
= 当前 run 是否拥有并可调用工具

output format
= plain / xml-segmented 等模型输出格式

delivery / segmentation
= assistant 正文提交为一条还是多个稳定 message

presentation surface
= UI 如何显示 reasoning、tool status 与 assistant 内容
```

`complete / stream` 是 transport，`tools` 是 capability。主题或 presentation profile 可以表达体验偏好，但不能拥有独立 reply flow，也不能把 theme ID 传入 application 来选择另一套业务链。

XML 只属于需要明确 `<message>` 边界的 segmented output format。它不等于 streaming、特定主题、全部短消息能力或 presentation surface。

Provider 不支持某种传输能力时，由 reply policy / model gateway 在既定 contract 中选择合法模式；不得在 UI、调用点或 persistence 层复制 fallback 链。

## 10. Tool calling 与 tool status

工具调用复用唯一 Agent Runtime run loop。Chat 不按主题复制 `ToolReplyFlow`，也不把非流式工具循环包进另一套 streaming persistence。

工具状态先形成主题无关的稳定 message metadata，再由 presentation 映射：

```text
runtime / message semantic
= tool identity、running / completed / failed、display metadata

ordinary presentation
= system text or standard tool status surface

official-replica presentation
= process card or themed surface
```

`toolNames` 保留真实 runtime identity，`displayNames` 保存 presentation alias。Presentation alias 不得反向参与 authorization、schema validation 或 execution。

所有工具调用都进入同一状态记录与历史上下文通道，不按工具类型隐藏。通话卡片、语音和表情包消息是业务输出，不能替代调用记录。工具意图提出时创建批次状态，执行前被参数或授权校验拒绝的调用也保留失败状态。通话请求成功后停止模型续轮属于等待外部动作，canonical 提交仍保存已完成的工具记录；真实用户取消和 supersede 继续服从原有提交 fence。

## 11. Streaming 与 persistence

Streaming 只改变增量传输与临时投影，不改变最终消息 ownership。稳定顺序事件由 Chat reply persistence 处理：

- reasoning / assistant segment 共享本轮需要的 logical identity；
- partial 内容只通过明确的 streaming projection 更新；
- final commit 由 Chat application 完成；
- error、cancel 与 tool outcome 使用稳定 metadata；
- conversation preview 只在 canonical 时机更新。

不得用 theme-specific component、XML parser 或 UI callback 充当消息事务边界。

## 12. Stateful timeline entry

Calls、Together Listening 等 Feature 可以通过 Chat 提供的窄 command 写入或 patch stateful timeline entry。Chat 只拥有：

```text
stable entry key
insert-or-patch
metadata
preview
timeline refresh
```

外部 Feature 仍拥有自己的 lifecycle truth。Chat 不理解 call 或 Activity 的合法状态转换，也不允许 presentation 反向驱动外部领域状态。

## 13. Group Chat

Group Chat 属于 Chat，但拥有独立的 speaker planning、持久 task、CAS claim、append 与 termination application flow。

群聊复用 Chat 的 message semantics 和 Agent Runtime adapter，不复制第二套通用 reply engine。群聊是否允许工具或某种 transport 由明确 capability / policy 决定，不由 presentation theme 推断。

## 14. Delivery

Assistant commit 后由 Chat 请求统一消息交付协调：

```text
assistant commit
→ AIMessageDeliveryCoordinator
→ 前台当前会话：suppressed
→ consumer 已展示：handled_by_consumer
→ 其他情况：native notification
```

Delivery decision 必须发生在 commit 后。模型调用、事务、Chat UI 和 native notification 不得形成相互嵌套的第二套提交路径。

## 15. 目录与依赖

```text
src/features/chat/
├── conversation/
├── messages/
│   └── events/
├── group/
├── reply/
│   ├── agent/
│   └── delivery/
├── presentation/
│   ├── messages/
│   ├── shell/
│   ├── conversation/
│   └── group/
├── composition.ts
└── index.ts
```

各子域可以拥有自己的 `application / domain / infrastructure`，但不得恢复 Chat 顶层横向 `application` 转发层，也不得让其他 Feature 深导入这些内部目录。

## 16. 长期检查

- Chat 是否仍独占 message semantics、preview 与 canonical commit？
- Agent Runtime 是否只返回 run outcome，而不写 Chat lifecycle？
- Public API、Public Facts、Internal Engine 与 Host Composition 是否保持分离？
- 外部 Feature 是否只通过 `@features/chat` 使用稳定能力？
- `complete / stream`、tools capability、output format、segmentation 与 presentation 是否保持正交？
- 是否为主题、工具或外部 Feature 复制了第二套 reply flow？
- Stateful timeline 是否只投影外部 truth？
- Delivery 是否始终发生在 assistant commit 之后？
- 内部不变量是否由 owner 保证，而不是在每层重复 fallback 或校验？
