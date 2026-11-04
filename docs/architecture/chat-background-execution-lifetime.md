# 普通聊天执行与应用持续运行

普通聊天沿 `T1 commit → ApplicationExecutionHost → ExecuteConversationTurns → ConversationTurnCoordinator`
执行。页面只提交应用宿主请求，不持有 AI run，也不为每条消息建立 Android 服务或 RN task。
总开关与唯一 RN 后台身份见 [应用后台运行](./application-background-runtime.md)。

## 所有权和截止

原生信箱接受请求返回 true，只表示请求已经登记，不再提供逐消息 Service 启动握手。
请求不被接受时保留持久 pending；已经取走但因进程死亡未完成的回合仍由既有恢复入口接管。
总开关关闭时不提供持续后台保证，也不另起临时服务；禁止改回页面执行。

聊天请求使用九分钟单调预算，覆盖原生信箱等待、数据库启动门和批量会话串行执行。
应用宿主向用例传递剩余预算、AbortSignal 与 JS 单调截止点，不再通过原生逐任务停止回执取消。
到期只取消这一业务请求并归还 CPU 登记；总服务和应用 RN 身份持续存在。
T3 在事务内检查截止点，过期整体回滚；Coordinator 在底层不响应 abort 时先收拢展示、
完成 T4 并撤销 owner，迟到执行仍受 fence、signal 与截止约束。
T3 已提交时只封闭未交付展示尾部，不回退 committed 或游标。

## 验证

原生测试保护共享身份、信箱一次消费、桥接等待预算和执行资源隔离；JS 测试保护启动门、
串行等待、取消传播、不响应 abort 时先 T4、T3 过期零提交和 T3 后超时只收口展示。
设备仍需连续三次发送后 Home，并覆盖总开关、悬浮窗、熄屏、无网络和进程死亡。
不以静态检查或 JVM 测试替代真机证据。
