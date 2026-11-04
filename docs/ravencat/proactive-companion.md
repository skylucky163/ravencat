# RavenCat 主动伴随

Self Wake 已合并到 AI 日程。所有定时自主行动由唯一日程真值、工具、投影与执行入口负责。Doze、OEM 回收、真实进程被杀与通知仍需设备验收。


## 1. 产品定义

主动伴随允许当前主理 AI 在没有用户新消息时，由 AI 日程取得一次正常单聊执行机会。AI 可调用零个、一个或多个已授权工具，也可不发送任何消息。日程不是一条预存的待发消息。

用户提出“稍后提醒”，与 AI 自己决定“稍后醒来”，使用同一套日程。没有独立的 Self Wake 工具或第二种调度队列。同一安排调整时间或内容使用 `update_ai_schedule`，不同时建立两种唤醒。

## 2. 所有权与真实链路

业务代码归 `src/features/companion`，跨 Feature 的具体组合由 Host 负责。

```text
create_ai_schedule / update_ai_schedule / cancel_ai_schedule
→ AIScheduleApplication（模型输入与内容、时间、来源校验）
→ SQLiteAIScheduleRepository（事务与状态机）
→ commit
→ AIScheduleProjectionOwner（串行投影与启停）
→ keyed Alarm / WorkManager
→ RavenCatAIScheduleWorker
→ native projection gate
→ RavenCatCompanionExecutionHost
→ ExecuteCompanionWake / RunHeadlessAISchedule
→ 15 分钟有效期与到期计划归并
→ Host 会话执行权协调（聊天优先，日程取最新）
→ Assistants Host Authority + SQLite claim
→ RunAIScheduleAutonomousAgent / RunHostAutonomousAgent
→ RunChatVisibleAgent（正常 Agent Runtime、工具与 Chat 提交）
→ consume / native completion
```

原生投影不是业务真值；它不能创造日程、决定行动内容或绕过 SQLite claim。消息交付仍由 Chat commit 后的 AIMessageDeliveryCoordinator 决策，不能另建主动消息流程。

## 3. 日程与工具

持久真值只有 `raven_cat_ai_schedules`，稳定 identity 是 `scheduleId`。状态：

```text
scheduled → claimed → consumed
scheduled → cancelled
```

创建、修改只接受未来时间；取消只接受尚未到期的 scheduled。查询及取消在主动伴随关闭时仍可用。summary 最长 160 字，details 最长 4000 字；来源快照由正常会话和消息边界验证。

系统跳过与归并同样终结到 `cancelled`，以 `cancelledReason=expired / merged_schedule / merged_chat` 区分，不冒充用户取消；主动生活按未执行历史显示，详情解释原因。超过原定时间 15 分钟仍未领取的任务永久失效，恰好 15 分钟仍可领取；已经开始的执行不因越过该时间再次取消。

正常主理 AI 工具只有：

- `create_ai_schedule`
- `list_ai_schedules`
- `get_ai_schedule`
- `update_ai_schedule`
- `cancel_ai_schedule`

日程不授予额外权限。每次执行都解析当前主理 AI 的工具授权、MCP、运行时暴露面与会话。

### 3.1 系统日历提醒

`create_ai_schedule` 默认 `system_calendar=true`，同时保存内部 AI 日程与手机日历的事件及零分钟提醒。缺少日历读写权限或没有支持提醒的可写日历时，在业务提交前报错，不创建内部记录，也不弹权限框。权限由用户在小程序的「权限与后台运行 → 系统日历」入口主动授权。用户拒绝或已有仅内部提醒偏好时，AI 可显式传 `system_calendar=false`；不静默降级、不反复索要权限。

`system_calendar` 是日程持久事实。既有记录升级后保持仅内部，不自动导出历史安排。更新默认保留原选择，也可显式切换；修改或移除已有系统事件需要日历权限。取消先提交内部终态，再移除系统事件；若授权已撤销，工具必须明确报告系统事件尚未移除，恢复权限后再同步。

SQLite 与 Calendar Provider 不共享事务。内部事实先提交，AI 唤醒投影与系统日历副作用分别执行；提交后的系统写入失败返回带稳定 scheduleId 和 calendarStatus 的部分成功，不能声称系统提醒已成功或重建第二份日程。系统事件用当前安装包与 scheduleId 标记，事件及提醒使用 Provider batch 原子写入；沿用现有投影 owner、bounded repair 和前台恢复入口幂等同步，不建立第二套调度队列。

系统日历负责独立提醒用户，不触发 AI 执行；AI 仍通过唯一的内部日程链路 claim 和运行。关闭主动伴随保留系统提醒，AI claim/consume 不删除已到期系统事件。两边设定相同时间，但内部非精确调度和模型生成不保证消息同秒到达。系统日历自身的通知设置仍由用户和手机系统管理。

## 4. 主动伴随开关

`raven_cat_companion_state.desired_enabled` 是开关真值。AIScheduleProjectionOwner 在同一 operation lane 提交意图并同步原生镜像；Repository 在 create / update / claim 的同一事务读取开关和绑定主理身份。这是持久化执行边界，UI 防抖或原生镜像不能代替它。

关闭时：

- 所有未消费原生投影撤销；日程计划与历史保留。
- 新建、修改及新的执行 claim 返回 `companion_disabled`。
- 迟到的原生 Worker 不 dispatch；已经 dispatch 的迟到 JS 回调仍受 Repository claim 边界约束。
- 已取得 claim 的 run 由原有 bounded execution owner 收口，关闭开关不补造、重放或接管它。

重新开启只恢复尚未到期的 scheduled 计划。暂停期间已错过的计划显示“未执行”，不补跑。主动生活界面明确提示暂停状态。

主理 AI 更换、撤销或删除仍由 Host Authority 处理；旧 owner 的 scheduled 日程取消并保留原身份，不能转交给新 AI。用户单纯关闭开关不会取消业务计划。

## 5. 响应证据与中断

`consumed` 只表示执行机会不可再领取，不等于 AI 已响应或工具成功。Chat 持有开始、模型响应、工具事件和真实终态；主动生活通过 runId 查询证据并展示：

- 过期未 claim：未执行。
- 已收到模型输出：显示 AI 已响应。
- 正常结束且有响应：已执行；行动结果仍以工具 outcome 为准。
- 执行途中被停止或进程死亡：执行因故障中断，保留已提交的文本和步骤。
- 准备、模型或执行失败：执行失误。

模型与工具准备前保存隐藏的触发来源，用于聊天定位与历史窗口锚点，不额外展示开始说明。响应和终态从共享 ConversationTurn 与持久展示事实读取，不重复写入“AI 已响应／执行结束”消息。模型增量沿普通聊天展示批次存档；执行到一半结束时保留已经交付的半段原文。后续冷启动／回前台只结算不属于当前进程活动句柄的旧 claim，共享回合与展示 owner 封闭中断状态；不重新执行模型或工具。完全没有获得执行机会的日程保持未执行。

## 6. Android 投影与执行

### 6.1 统一投影

每个 scheduleId 对应独立的 inexact Alarm 与 OneTimeWork；二者共享同一版本身份与 native gate。Alarm 只将该日程交给同一 keyed Worker，不启动另一种业务 run。更新替换同一 identity，取消移除该 identity。

native gate 原子检查开关、remindAt 与 projectionToken 并消费镜像；只有一个 winner 进入执行宿主。SQLite scheduled → claimed CAS 再裁决业务执行权。deliveryEventId 是 `scheduleId@projectionToken`，旧版本回执不能污染新版本。

使用 Android 13+ 的 `setAndAllowWhileIdle` 保留 idle 下系统唤醒能力；它不是准秒计时保证。WorkManager 的系统调度也可能延迟，代码不把迟到本身解释为 AI 违约或新日程。

### 6.2 恢复与清理

冷启动／回前台先在 SQLite 终结超过 15 分钟的 scheduled，再重建未来投影、撤销终结项镜像。只有仍在有效期内且版本匹配的既有到期投递可继续；过期项即使恢复了原 Work 也不能再次 claim 或启动模型。原生 boot／package replace 只恢复未来 Alarm，不访问 SQLite 或主动运行模型。

投影故障不能回滚已提交的日程。现有 bounded projection repair 只同步镜像，不重放模型或工具。关闭后持久化开关已经阻止新的 claim，镜像故障不会越过业务边界。

### 6.3 后台执行宿主与应用持续运行

主动伴随只拥有日程投影和本次 delivery 的执行，不拥有应用级保活开关。通用后台保障由
`modules/background-runtime` 的独立总开关控制；聊天、日程完成与悬浮窗开关都不能停止它。
日程请求进入同一 ApplicationExecutionHost，不创建逐日程 Service 或 RN task。总开关关闭时，Worker 仍按系统授予的执行窗口尽力执行。

```text
Alarm / WorkManager → native gate
→ RavenCatCompanionExecutionHost
→ ExecuteCompanionWake
→ SQLite claim → 正常 Agent Runtime → consume → 终态回执
```

Worker 等待本次 delivery 的回执，不能把任务交给 JS 后立即返回成功。等待上界十分钟；
超时或 Worker 被系统停止时，先按 deliveryEventId 将取消事实保存到 native，再通知 JS，
最多等待六十秒取消宽限。得到回执记为 COMPLETED，否则分别记为 TIMED_OUT 或 WORKER_STOPPED。
这些结果不表示 JS 已经停止，也不表示同一 delivery 可以重跑。共享前台服务不会延长 Worker 的系统预算。

runner 先注册 AbortController，再消费 native 取消标记，覆盖晚注册与事件夹缝。
取消不能只存在 JS 内存，也不能在同一 delivery 重投时清除。回执身份与取消身份均为
`scheduleId@projectionToken`，SQLite CAS / consume 继续承担业务正确性。

CPU 执行锁由共享原生 owner 管理；业务结束或到期只归还本次登记，不释放其他请求的资源。
日程执行收口仅清理本次执行，不停止应用级前台服务，不改变总开关或 Floating Interaction。

诊断分别展示 `applicationBackgroundRunning` 与 `overlayForegroundServiceRunning`。
`lastCompanionExecutionForegroundRunning` 记录本次宿主收口时应用持续运行的真实状态；
历史阶段记录仍可读取，不能将旧执行期服务的记录误认为当前还在创建日程保活任务。

真机验收覆盖：总开关开启后连续多次日程不闪退后台通知；关闭总开关不关闭主动伴随，
日程终态不关闭总服务；悬浮窗 OFF / ON、熄屏、Doze、OEM 回收、无网络、进程死亡、重启、
日程更新与取消仍按同一版本 gate 执行。设备证据不能用本地测试代替。

## 7. 单聊上下文与行动记录

自主唤醒走普通单聊 Prompt、人设、聊天摘要和未处理原文；历史之后的本轮 system 说明最新日程到期和自主活动时间，不创建 user role 的唤醒输入。工具目录、权限解析与正常单聊共用。共同前缀尽可能保持一致，实际缓存命中由模型服务决定。

同一会话的普通回复、重写和自主行动共用 Chat 的持久执行槽。同批到期安排在一个日程事务内选出计划时间最新者，同时间按 updatedAt、scheduleId 降序；旧安排终结并将背景交给胜出日程。新的有效日程可撤销正在执行的旧自主 owner；旧网络返回仍受原 T3 fence 限制，已发生的工具动作不回滚。

遇到正常聊天、待回复用户输入或交付，日程背景交给正常聊天，不等待它结束后再唤醒。T1 的 Host 适配先提交背景交接再启动聊天，晚到的旧 consume 不会丢掉资料。宿主超时或准备失败同样留下处理结果，不建立新的执行队列或重试入口。

`raven_cat_ai_schedule_context` 只持久保存结果及交接凭据。过期、模型／工具失败和中断结果只在下一次普通单聊的「本轮交互环境」提供，不单独唤醒 AI；旧日程的归并背景进入相应最新日程或正常聊天。本批记录先提供总数与原定时间范围，再在 8000 字符内最多展开 20 项摘要、ID 和结果；空间允许时同时携带归并详情和来源。未展开内容明确标识，并可通过现有分页列表和按 ID 工具读取；确认的是这一批摘要已告知，不声称详情已处理，也不让剩余记录永远挂在已完成日程上。显式重写、群聊、摘要生成不消费这些资料。

凭据绑定实际 replyRunId，以 Chat 的 committed 事实确认已告知；请求失败、取消或组装后没有提交时，后续自然回合仍可读取。目标变更保留旧凭据，已成功交付的内容不会因转交再次出现；读取与绑定之间发生归并时，以原目标、原因和凭据 CAS 拒绝迟到绑定。这张表没有调度能力，不发布唤醒事件，也不把结果永久放进稳定提示词前缀。已发给模型的请求不强行改写，后到资料留给下一次自然组装。

自主执行与普通聊天共用 `ChatTurnPresentation`、行动时间线、T3 单事务提交和统一交付。思考及工具状态进入行动步骤，模型正文（包括工具前言）生成时直接进入独立气泡，不先塞入日程过程卡，也不等待终态再转换。流式与最终提交沿用同一稳定气泡身份，不重复分段、计时或交付。失败或中断保留共享展示中已交付的文本与工具事实，不把半段正文提交成完整回复；后续上下文沿隐藏触发来源读取这些历史资料。运行时未输出的内部思考不属于可记录数据。

AI 不想再发送文字时，最终正文只输出 `[[NO_MESSAGE]]`。`finalAssistantPolicy: autonomous_reply` 只承担这一静默差异：流式隐藏控制信号前缀，完整匹配后保存静默行动记录，不产生额外文字消息、未读、预览或通知；不解释自然语言，不新增静默工具，关闭模型工具时同样可用。模型完全空白、请求失败与取消不伪装成静默成功。静默不撤回此前已展示的正文、语音、贴纸或其他行动。

语音、贴纸仍由各自工具准备并经 Chat 提交。过程记录不触发用户消息通知、未读或会话预览。媒体提交钩子是提交后的资源确认步骤，故障信息用用户能理解的执行结果表达。

## 8. 主动生活与历史

主动生活只读取 AI 日程及 Chat 响应证据，提供 future / running / history，不建立第二份业务状态。时间碎片通过开放日期弧线查看任意本地日历日，固定回收九个照片节点，不累计无限日期元素。日期计数和当天首屏共用一个 Repository 快照；运行中按 startedAt、历史按实际 claimedAt、未执行按原定时间归属日期。当日先展示运行中及下一次安排，再展示历史，各组内按时间与稳定 identity 分页。Chat 响应证据在事务提交后补齐。共享星空背景与记忆模块解耦，前台生命周期和手势仍由各自页面拥有。

未来、运行中与历史条目均可打开详情，展示创建时间、计划时间和实际开始时间；实际开始使用持久 `claimedAt`，未领取显示尚未开始，不用计划时间或投影版本代替创建事实。

Chat anchor 只通过 runId 定位，不向日程 domain 复制会话事实。同一个 run 可被实际消息分隔成多个行动步骤分组，但生命周期与响应证据按整个 run 展示，不能把前一段误报为仍未结束。

## 9. 升级边界

SQLite 迁移114 将旧 Self Wake 计划与历史迁入 AI 日程，保留 wakeId 作为 scheduleId、owner、claim runId 和时间戳。superseded 映射为 cancelled，旧工具授权搬到创建日程工具；已有新工具授权优先。摘要与背景按现有日程长度边界迁入，旧 Chat 原文和执行记录不改写。

旧 Self Wake 表和工具入口删除。原生升级清理一次旧单值 Alarm／Work／偏好镜像，不再恢复旧链路。旧 Chat 的触发类型与工具显示名只服务历史展示，不提供调度入口。

本地验证覆盖状态机、暂停保留、重新开启不补跑、迁移回滚、单聊上下文、增量存档、取消与 native gate。Doze／OEM 回收、真实进程被杀和通知仍需设备验收，不以 JVM 检查代替。
