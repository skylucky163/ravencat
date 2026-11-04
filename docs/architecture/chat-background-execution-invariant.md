# Chat 后台回合执行所有权不变量

> Architecture Invariant
> Protected Contract

`ExecuteConversationTurns` 通过 Host 的 `ensureHostDatabaseReady()` 顺序等待恢复门与普通数据库初始化。设备固定回归需要独立证据，不能通过页面执行兜底解决。

应用持续前台运行由独立总开关拥有，聊天任务共享项目 CPU 锁，不再逐条启停保活服务。共享身份、业务预算和取消收口的具体边界见 [宿主生命周期](./chat-background-execution-lifetime.md)。这不放宽本文的唯一执行宿主、恢复与真机验收约束。


本文是普通 Chat AI 回复后台执行的永久架构约束。它保护的是执行生命周期的所有权，
不是 UI 投影或通知策略。修改 `SendUserMessage`、`ConversationTurnCoordinator`、
`ConversationTurnExecutionHost`、`ExecuteConversationTurns`、`replyCallbacks` 或
相关 wiring 前，必须重新阅读本文并完成文末真机验收。

回合固定输入区间、T1～T4、revision 与提交 fence 的持久化约束见
[`conversation-turn-coordination-invariant.md`](./conversation-turn-coordination-invariant.md)。

完整正文持久展示发布与 assistant message T3 commit 之后的用户交付与通知策略，
见 docs/architecture/ai-message-delivery-invariant.md。

## 1. 已发生过的真实故障

真机曾稳定复现以下顺序：

```text
普通 Chat 前台发送
→ T1 用户消息成功落库
→ 立即将 App 切到后台
→ AI run 在页面 React Native JS runtime 中停止推进
→ assistant 回复未落库，系统通知也未出现
→ 回到前台后 AI run 几乎瞬间完成
→ assistant 回复落库，通知随后出现
```

通知不出现只是下游结果，不是根因。根因是执行所有权错误地落在页面 React Native
runtime；Activity 不可见后，该 runtime 的网络消费和 Promise 后续执行可能被冻结。
普通 Chat 页面因此不能持有 AI run 的完整执行生命周期。

## 2. 唯一正确的所有权链

普通 Chat 的 canonical `user_reply` 必须沿着以下链路执行：

```text
普通 Chat page
→ T1 user message commit
→ executionMode: delegate_to_android_host
→ Android-backed execution host
→ ApplicationExecutionHost → ExecuteConversationTurns（共用应用 RN 身份）
→ coordinator claim + execute，持续等待到 terminal
→ T3 assistant message commit
→ AIMessageDeliveryCoordinator 负责 delivery / notification
```

页面在 T1 提交后可以取消已被 supersede 的句柄，但不得在页面 runtime 中 claim、
执行或 fire-and-forget AI run。Android execution host 启动失败时，已持久化的 pending
状态必须交给后续 host 或启动恢复接管，不能回退到页面执行。

应用宿主内的受控业务用例（例如 RavenCat `executeFloatingMessage`）可以
明确选择 `executionMode: inline_current_host`，由当前 host claim、执行并等待 terminal；
该模式不得再次启动第二个 Android ConversationTurn execution host。

## 3. 执行所有权必须显式建模

执行身份只能由窄且明确的 `executionMode` 契约表达：

| 模式 | 语义 |
| --- | --- |
| `delegate_to_android_host` | 当前调用者不是可靠的后台 host。T1 后启动 Android-backed host；普通 Chat page 必须使用此模式。 |
| `inline_current_host` | 当前调用者已经是会持续等待到 terminal 的受控 execution host；仅由该 host 显式 opt-in。 |

普通调用方省略执行模式时，默认必须是安全的 `delegate_to_android_host`，不能退化成
页面执行。不得通过 `replyCallbacks`、`AppState`、`correlationId`、`deliveryTiming`、
调用栈或 React mounted 状态猜测身份。

## 4. 投影与执行边界

```text
replyCallbacks ≠ execution ownership
Notification   ≠ execution host
```

`replyCallbacks` 只表达回复如何被观察、投影或展示（例如 `notifyUI`、流式片段和
最终回复回调）。普通页面即使携带非空 callback，仍然必须委派 Android execution host；
callback 是否存在不得改变所有权。

通知只在完整正文展示版本或正式消息 commit 之后由统一 delivery 协调器决定是否展示，不能承担
持有、恢复或推进 AI run 的 execution-host 职责。

## 5. 明确禁止

以下行为违反本 Protected Contract：

1. **禁止页面 fire-and-forget AI execution。** 页面不得以 Promise、timer 或其他页面
   runtime 机制独占需要跨 Activity 生命周期完成的 AI run。
2. **禁止 callback 决定 execution ownership。** 不得用 `Boolean(replyCallbacks)` 或
   任意 presentation / delivery callback 是否存在来判定 host 身份。
3. **禁止 execution host 失败后 page fallback。** `executionHost.start(...)` 返回
   `false` 或启动失败后，不得调用 `executeInline`、`launchTurn`、`agentRuntime.run`
   或等价页面 fallback；必须保留 pending 持久化事实，等待 host/recovery 接管。
4. **禁止为了 slimming、abstraction 或 callback unification 删除 execution-host
   边界。** 任何“简化”都不得把普通 Chat 的执行生命周期带回页面 runtime。

## 6. Canonical 用户输入边界

普通 Chat 的 `user_reply` 游标、高水位、启动恢复扫描与固定输入区间只能统计
canonical 用户消息。`metadata.type = 'callStatus'` 的通话状态气泡即使为了时间线展示使用
用户方向，也不是用户向 AI 发出的聊天输入，不得触发、扩展或恢复普通 Chat 回复。

通话结束后的可选普通消息必须由 Calls 的显式终态事实触发，并由独立的结构化决策决定
发送或保持沉默；不得重新利用通话状态气泡制造隐式 `user_reply`。

## 7. 修改后的真机验收

凡修改本区域，必须在 Android 真机重复固定回归场景，连续至少 **3 次**：

```text
打开普通单聊
→ 发消息并确认 T1 成功
→ 立即按 Home，将 App 保持后台
→ 等待 AI 在后台完成
→ 确认 assistant reply 已经落库
→ 确认系统通知出现
→ 点击通知返回，确认回复已经存在
```

AI 只有在回到前台后才完成、落库或出现通知，均明确视为失败。还应单独确认
RavenCat 悬浮消息调用以 `inline_current_host` 正常执行并展示回复。

静态检查和脚本 verifier 不能替代上述真机证据；在连续三次真机通过前，不得宣称后台
冻结问题已关闭。
