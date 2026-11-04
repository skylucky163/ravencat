# 应用后台运行模块

独立总开关拥有 `RavenCatBackgroundService` 和唯一的 RN 应用执行身份。
`ApplicationExecutionHost` 将所有后台业务请求交给同一应用 runtime，不为消息或日程创建 Service 或 RN task。
桥接前的内存信箱不承担持久恢复；业务取消、提交与恢复仍归各 Feature。
`ExecutionWakeLocks` 在业务执行期间管理一把共享 CPU 锁，空闲不持有。

设置与恢复经 `@platform/device` 提供给 Host 和设置页；原生业务模块通过窄入口提交执行请求。
通话媒体沿用同一运行身份，可以在总开关关闭后继续到通话结束。
模块不管理聊天内容、日程真值、媒体状态或 Provider 网络协议。
完整契约与设备验证见 [应用后台运行](../../docs/architecture/application-background-runtime.md)。
