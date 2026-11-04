# RavenCat 能力架构

本文组织当前主动伴随、AI 日程、悬浮交互、手机能力、系统访问与一起听的产品边界。业务模块按 Feature 所有权组织，RavenCat 产品名不对应一个包办全部能力的综合 Feature。

## 文档入口

| 文档 | 职责 |
| --- | --- |
| [能力模型](capability-model.md) | 用户功能、底层能力、开关与依赖边界 |
| [主动伴随](proactive-companion.md) | 主理 AI 的日程执行、开关、响应证据、Headless 与有界执行期 |
| [AI 日程](ai-schedule.md) | 唯一日程状态、工具、投影、claim 与升级 |
| [悬浮交互](floating-interaction.md) | 悬浮球、快捷聊天、Extract/Shot 与 Overlay FGS |
| [系统访问与权限](system-access-and-permissions.md) | 能力状态、按需授权、设置引导与 OEM 限制 |
| [屏幕观察](screen-observation.md) | Extract、Shot、OCR、窗口 fence 与隐私 |
| [设备控制](device-control.md) | Soft Lock、打开应用、URI dispatch 与媒体动作 |
| [手机工具](phone-tools.md) | Protected Apps、工具包发现、授权与 Host authority |
| [网易云工具包](netease-music-tool-package.md) | 公开数据、官方 App 点歌与 MediaSession 的八个工具 |
| [一起听](together-listening.md) | 独立 Activity、双向邀请与跨 Feature 展示 |

## 唯一自主执行链

Self Wake 已合并到 AI 日程。用户提醒与 AI 自己安排未来行动使用同一套 `raven_cat_ai_schedules`、scheduleId、管理工具、keyed 原生投影与执行入口。不存在第二套单值 Self Wake 计划或 successor 工具。

```text
日程工具 → SQLite scheduled
→ commit 后 keyed Alarm / WorkManager 投影
→ native gate → Companion execution host
→ Host bootstrap 与主理身份解析 → SQLite claim
→ 正常 Agent Runtime / 已授权工具 / Chat 事实
→ consume 与 runner 终态回执
```

日程只提供一次行动机会，不预存必须发送的消息，也不授予工具权限。AI 可以使用零个或多个工具，或者不发消息。原生投影可重建，业务真值始终在 SQLite。

主动伴随关闭时保留计划与历史、撤销投影并拒绝新建/修改/claim；查询和取消仍可用。重新开启只恢复未来计划，不补跑错过的安排。旧进程 claim 只结算中断，不重放模型或工具。主动生活从唯一日程事实与 Chat run 证据读取未来、当前执行和历史，不自行维护另一套执行状态。

## 所有权与独立开关

| 所有者 | 能力 |
| --- | --- |
| `features/companion` | 主动伴随、AI 日程、投影与业务执行状态 |
| `features/floatingLayer` | 悬浮球、快捷交互与 Overlay 展示 |
| `features/deviceControl` | Device Observer、Device Control 与 Soft Lock |
| `features/screenCapture` | 窗口准入、安全截图和 native cache 生命周期 |
| `features/togetherListening` | 邀请、Activity 与一起听产品规则 |
| Host | 跨 Feature 工具、Prompt、通知和 Android 执行组合 |

Floating OFF 与 Companion ON 必须独立工作：没有悬浮球和 Overlay FGS，AI 日程仍可后台执行并由统一消息交付路径决定通知。通用保活由「持续后台运行」独立总开关拥有，开启后跨聊天和日程持续运行；Companion 只管理一次任务的有界等待与取消，不创建临时保活服务。关闭任意产品开关不撤销系统权限或停止无关 Feature。

Device Observer 只提供事实；Device Control 执行动作，不决定 AI 行为或写 Chat 消息。屏幕采集不决定 Companion 何时截图。Permission Center 展示系统能力并引导用户授权，不理解业务流程，也不成为权限真值的缓存副本。

一起听是独立 Activity，不属于网易云工具包，也不由检测到音乐播放自动开启。Chat timeline、通知、indicator 与浮层只消费投影。

## 验证边界

各 Feature 的行为验证保护状态机、权限、CAS、重复投递与取消。Android Doze、OEM 回收、真实服务、进程被杀、通知和悬浮展示需独立设备验收；不能从阶段编号或自动检查推导整项功能已验收。
