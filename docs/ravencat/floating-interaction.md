# RavenCat Floating Interaction

>
> 目标：定义悬浮球、悬浮层和快捷聊天的产品职责，避免 Floating Layer 继续吸收主动伴随、权限管理和设备观察的生命周期。

## 1. 产品定位

Floating Interaction 的用户语义：

> 即使用户停留在其他 App，也能快速找到 RavenCat、打开快捷聊天，并主动把当前页面交给 AI。

它是用户主动交互入口，不等于“主动伴随”。

### 1.1 全局可见性约束：仅在 App 外展示

Floating Interaction 是 RavenCat 的 App 外交互 surface。只要 RavenCat 自身处于前台，
所有 RavenCat overlay window 都必须隐藏，包括 Bubble、普通 Chat Panel、Together Panel
及其内容；App 内由对应的 presentation（例如 Together Listening indicator、CallMiniWindow
和普通 Chat UI）负责展示。这样不会出现 RavenCat App UI 与 RavenCat system overlay 叠加。

前台切换只改变窗口可见性，不改变 Floating Service 的所有权、native runtime attachment、
snapshot、Together projection、Bubble 位置或 skin。不得在 App 前后台切换时反复
`startFloatingLayer()` / `stopFloatingLayer()`；Service lifecycle 与 window visibility 是两条
独立的状态轴。

Host 使用既有 `AppState.currentState` 和 `AppState` change listener，通过 Floating Layer
public port 下发 `setAppForeground(active)`。启动对账必须先提交已知的 AppState，再执行
`reconcileFloatingInteraction()`，避免 cold launch 在 Splash 或首页上方短暂显示悬浮球。
native 尚未收到明确 AppState 时必须 fail-closed：未知状态暂不展示，直到 Host 明确下发
`active=false`。不得使用 UsageStats、Accessibility 或前台 package 轮询猜测 RavenCat 是否在前台。

Host bridge 之外还有独立的 native fail-safe：`Application.ActivityLifecycleCallbacks`
驱动的 `RavenCatAppForegroundActivityTracker` 在任何 RavenCat Activity resume 时 acquire
`APP_FOREGROUND_NATIVE_ACTIVITY` suppression，全部 pause 后主循环末尾 deferred release
（App 内 Activity 切换不会闪出 Bubble）。即使 JS 线程崩溃、Host bridge 未执行，overlay
也必须随 RavenCat 前台隐藏。Host（`APP_FOREGROUND_HOST`）与 native Activity
（`APP_FOREGROUND_NATIVE_ACTIVITY`）是互不 release 的独立 reason。fail-safe 只控制窗口
可见性，不启动或停止 Service。

从前台进入后台时，若 Floating Interaction 已启用且 runtime 可用，只恢复 BUBBLE；即使之前
在其他 App 中展开过 PANEL，也不得自动恢复 PANEL。Together projection 可以继续保存在
snapshot/cache，但不覆盖这条全局可见性约束。

可见性隐藏必须按原因分别记录（App foreground host、native Activity foreground 与
Screen capture）。释放截图隐藏不能越过仍然存在的前台隐藏；只有所有 suppression reason
都释放且 Host 已明确处于后台时，才允许恢复 Bubble。

当前业务代码归 `src/features/floatingLayer`，不是 Companion 的内部子能力。它与 `src/features/companion` 通过 Host composition 连接；底层 Overlay Service 与 native bridge 仍可保留 RavenCat 品牌名。

允许存在：

```text
悬浮窗 ON
主动伴随 OFF
```

用户仍然可以：

- 点开悬浮球；
- 进入快捷聊天；
- 使用 Extract；
- 使用 Shot；
- 查看悬浮层状态。

### 1.2 Together Listening：只消费投影事实

Together Listening 与 Floating Layer 是 peer features。Together Activity 仍由 Together Listening
Feature 持有；Floating Layer 只消费 Host 组合后的窄 presentation DTO，不读取 Together、Chat 或 Profile
repository，也不自行判断 Together lifecycle。

DTO 只包含：

```text
activityId
hostAiId
chatSessionId
activatedAtEpochMs
aiName / aiAvatar
userName / userAvatar
```

active Together 始终同步到原生 snapshot 与 projection-only cache，与悬浮窗开关、权限和 Service 是否运行无关。
Service attach 时恢复缓存，保证先进入一起听、后开启悬浮窗也能展示当前 Activity；终态即使在 Service 停止时也清除缓存。
窗口仍只在用户已开启 Floating Interaction、overlay permission 已授予且既有 service 正常运行时展示。
Together 不会申请权限、打开设置或启动 Floating service；active 也不会自动展开 PANEL，
用户点击现有 RavenCat bubble 后才打开 PANEL。悬浮球 skin、位置、拖动与 edge snap 保持原有
行为，不创建第二个 headphones bubble 或新的 WindowManager owner。

Together 与 Chat 是同一 PANEL window 内的两个 page（`RavenCatPanelPage.CHAT / TOGETHER`），
窗口状态机仍只有 `BUBBLE / PANEL / HIDDEN`。点击 Bubble 时：无 active Together 进入 CHAT page；
有 active Together 默认进入 compact TOGETHER page。视觉顺序为 CHAT 在上、TOGETHER 在下：
TOGETHER 上滑回 CHAT；CHAT 仅在消息区已滚到顶部或手势起于非滚动背景时，才接管向下滑动进入
TOGETHER。composer、Shot 与收起按钮不参与分页手势；不再展示分页圆点。
切页时 WindowManager geometry 仍只提交一次；Q 弹过渡只作用于窗口内 View content，
通过短距离纵向位移、淡入和轻微 overshoot 表达方向，不旋转或逐帧 resize 悬浮窗口。

共享 header 在两个 page 中始终存在，标题随 page 切换（RavenCat / 一起听），“收起”入口位置与语义
一致，永远执行 `RavenCatOverlayIntent.Collapse` 收起到 Bubble；Together content 内不再重复 collapse
control。TOGETHER page 是极简 compact 内容（`TOGETHER_PANEL_CONTENT_HEIGHT_DP = 112`）：只有双方
头像（AI 左、用户右）与 native elapsed duration；不展示名字、歌曲、artist、album、progress、
playback controls 或按钮。duration 由 native 根据 `activatedAtEpochMs` 本地计算，不由 JS 每秒重投影。
进入 App 内精确聊天由 standard notification 的 `hostAiId + chatSessionId` 导航承担，悬浮层不再重复
该入口；overlay V1 不复制 Together leave action。page 切换时同一个 panel window 通过
`WindowManager.updateViewLayout` 动态 resize（CHAT 沿用既有比例高度，TOGETHER 使用 compact 高度），
不 remove/recreate window；切入 TOGETHER 时释放键盘与 composer 焦点，切回 CHAT 不自动弹键盘。

Together lifecycle 与 page 的关系：用户在 CHAT page 时 Together 开始只开放 TOGETHER page，不强行
切页；Together 结束时若当前停在 TOGETHER page 则收起到 Bubble，若停在 CHAT page 则保持 Chat Panel
并关闭 TOGETHER page。

终态清理必须按 `activityId` identity-safe：旧 Activity 的迟到 clear 不得删除新 Activity projection。
允许在 Floating native module 内持久化 projection-only cache 以应对 service/process attach；canonical Host
projection 可以覆盖它，terminal 与 factory reset 清除它，cache 不得读取 SQLite、唤醒 AI 或决定 Activity
lifecycle。无 active Together 时，ordinary panel 的 header、conversation preview、Shot、composer、send、
focus、bubble skin、edge docking 与 screenshot coordinator 语义保持不变。

## 2. 悬浮球的三种职责

悬浮球不是单纯按钮，它同时承担：

### 2.1 快捷入口

- 打开 Chat；
- 打开 Extract；
- 打开 Shot；
- 展开其他悬浮交互。

### 2.2 可见存活指示

悬浮球存在时，可以作为一个简单、用户可见的后台宿主存活信号：

```text
球还在
≈ Overlay foreground service / native overlay runtime 仍活着
```

但它不能被定义为：

```text
球还在
= RavenCat 所有 runtime、数据库、AI、调度都健康
```

内部 health 必须保留更细粒度状态。

### 2.3 RavenCat 的可见“身体”

球及其变形体提供持续但低干扰的在场感。

这属于 UI/交互语义，不应因此把所有后台能力都放进 Floating Layer。

## 3. 形态与休眠

当前产品已经支持：

```text
active bubble
→ idle for several seconds
→ dock to edge
→ expose about 60%
```

如果仍然遮挡内容，可以未来增加更深休眠形态：

```text
active
→ docked
→ dormant edge marker
```

例如：

- 细胶囊；
- 边缘小条；
- 猫尾巴/羽毛尖等品牌化形态。

关键原则：

- 视觉缩小后，Window 的实际触摸区域也要同步缩小；
- 不允许用大面积透明 hitbox 假装“不挡”；
- 深度休眠是否可直接点击/拖出，由 UI 设计决定；
- 这些形态变化不改变 Floating Interaction 的启用状态。

### 3.1 悬浮球外观设置

内置形象只有「鸦鸦」，来自 `assets/yaya.png` 的单张 PNG。设置页直接引用该资源，Android
构建时从同一文件生成 raw resource，不维护第二份图片。自定义装扮先上传正面图片，可选上传独立贴边图片；未上传贴边图时
复用正面图。两种情况下都以贴右为原始方向，贴左水平镜像，离开边缘后恢复正面原方向。
设置页按纵向卡片展示正面、贴左、贴右预览，共用页面滚动。

每套皮肤独立保存大小（32–96 dp，默认 56 dp）。用户选择皮肤后拖动调节，松手才提交到原生；
期间由设置页持有预览草稿；轨道由原生手势接管，避免快速拖动被页面滚动中断，系统中断时也保存最后的调整值。
实际大小预览按当前屏幕 1:1 显示，保留透明留白，并按原生像素
取整和 60% 露出比例展示贴边裁切。窗口、触摸范围、拖动与贴边几何由同一个原生 Controller
尺寸驱动，切换皮肤时使用对应大小。

外观文件、选择、各皮肤大小属于原生外观 Store，随外观备份 v2 恢复；旧全局大小在升级和
恢复 v1 备份时转成已有皮肤的初始大小。旧内置选择迁移为当前内置形象，已有单图自定义皮肤无需补图。

View 在后台按窗口像素尺寸加载当前皮肤的两种形态，并复用位图；位置与消息投影更新不触发
文件读取或重复解码。换图使用新的文件身份，换皮肤、调整尺寸或 View 移除后，迟到解码结果
不得覆盖新的展示。Overlay 生命周期与消息交付契约不受外观设置影响。

## 4. 快捷操作

目标入口：

```text
Floating Layer
├─ Chat
├─ Extract
└─ Shot
```

### Chat

用户主动与 RavenCat 对话，不需要切回主 App。

聊天区与 App 中主理 AI 的 canonical conversation 同步，始终替换最近 6 条已到达的
可展示消息，不分页加载更早历史。消息新增、改写、删除、清空及分段到达触发刷新；
Host 数据库就绪、前后台切换、Service attach 与展开面板时重读当前有限窗口。
Host 组合 Chat 查询与原生展示 DTO，Floating Layer 不读取 Chat 仓储。原生按消息 ID
合并回复回调，按 clientMessageId 接管本地发送气泡，避免重复；pending/error 属于
本地发送状态，目标切换时清除。单条长消息沿用摘要显示，完整内容在 App 中查看。
会话投影的原生参数使用显式字段与嵌套消息 Record，按字段类型转换可空 sessionId /
clientMessageId；不将嵌套 DTO 交给通用 Any 转换或手工强转。
缓存投影同步不产生已读。原生 CHAT 页完成布局或滚动后，只回报 viewport 中实际可见的
assistant 消息 ID，Host 经 Chat 精确已读命令提交；收起、隐藏、TOGETHER 页与滚动区外
消息不产生已读。该入口统一覆盖 App 同步消息与悬浮发送回复，不再维护 correlationId
到消息 ID 的待确认映射和 TTL。通知交付仍由既有回复投影结果与统一交付协调器承担。

### Extract

用户主动要求 RavenCat 读取当前页面的文字/语义。

依赖：

```text
Accessibility semantic capability
```

缺少权限时：

```text
Extract
→ dependency missing
→ route to unified System Access screen
→ focus accessibility / screen-content-reading item
```

Floating Layer 不拥有 Accessibility 授权。

### Shot

用户主动截取当前画面，截图先暂存在悬浮面板输入区，不立即调用 AI。

截图不清空已输入文字，也不自动添加问屏提示词。用户可继续输入消息后点击发送，
或不输入文字直接发送图片。输入区提供截图预览与移除入口；重新截图成功后替换旧草稿。
暂存截图由当前进程的输入区持有，发送时才沿既有 Chat 附件提交链路持久化；移除、替换、
关闭悬浮层及过期截图回调均释放临时截图，收起面板则保留草稿。

Shot 保持独立，不因 Extract 存在而被删除。

## 5. 开关语义

应有独立用户设置：

```ts
floatingInteractionEnabled: boolean
```

关闭时：

```text
stop overlay service
remove overlay windows
stop overlay UI runtime
stop floating-only native interaction tasks
```

不得自动：

```text
turn off proactive companion
cancel proactive schedules
revoke Accessibility
turn off Usage Access
revoke notification permission
```

系统权限属于用户和 Android，不属于悬浮窗 Feature。

## 6. 与主动伴随的关系

正确关系：

```text
Floating Interaction     Proactive Companion
        │                         │
        └────── peer features ────┘
```

错误关系：

```text
Proactive Companion
└─ Floating Layer
```

也错误：

```text
Floating Layer
└─ Proactive Companion scheduling
```

两者可以共享平台能力，但不拥有彼此。

## 7. 与 Device Observer 的关系

Floating Interaction 可以调用 Device Observer：

```text
Extract -> semantic snapshot
Shot    -> screenshot
```

但 Floating Layer 不实现：

- AccessibilityService lifecycle；
- node tree traversal；
- 当前窗口识别底层；
- 系统权限检测；
- screenshot native writer 的通用逻辑。

这些底层事实与实现由 `src/features/deviceControl` 中的 Device Observer contract 及其 native/platform implementation 提供。Shot 的安全检查、截图执行与 native cache 生命周期归 `src/features/screenCapture`，Floating Layer 不复制这些职责。

## 8. 与 System Access 的关系

Floating Interaction 只声明依赖：

```text
base floating window
required: overlay

Extract
required: accessibility

Shot
required: screenshot-capable screen observation path
```

缺失时由统一权限中心处理。

Floating settings 页面可以显示简化状态，例如：

```text
悬浮显示：已允许
屏幕内容读取：未开启
```

但点击后跳统一权限页，不复制一套权限管理 UI。

## 9. Native Service 边界

`RavenCatOverlayService` 应保持窄职责：

- foreground service lifecycle；
- attach/detach Overlay Runtime；
- show/hide bubble；
- notification；
- running state。

不应新增：

- proactive wake planning；
- WorkManager business schedule；
- Accessibility service management；
- screen observation policy；
- AI route selection。

### 9.1 Overlay FGS 的所有权与不可依赖关系

`RavenCatOverlayService` 的生命周期归 Floating Interaction：

- 它提供**悬浮 UI 的 foreground lifecycle**（`floatingInteractionEnabled` 与其 runtime 状态）；
- **它不是 Companion 的 keep-alive service**。Companion 的调度、claim、Agent run、消息 commit 与通知交付不得读取它的运行状态，也不得把「进程因为 Overlay FGS 而更容易存活」当作成功前提；
- 其它 Feature 不得因为它的存在偶然让进程更容易存活而依赖它；
- 反向同理：关闭/开启 Floating Interaction 只停止或启动 Overlay Service 与悬浮 UI，不得取消 Companion wake、不得停用 Companion、不得停止正在执行的 Companion run、不得修改 Companion 的 SQLite 事实。

应用级持续后台运行由独立总开关拥有，见 [后台运行契约](../architecture/application-background-runtime.md)。Companion 只拥有一次执行的等待与取消，不创建或销毁通用前台服务；Overlay FGS 继续只拥有悬浮 UI。

因此合法的运行时组合必须包括：

```text
Floating Interaction OFF
Proactive Companion ON
=> 没有 Overlay FGS，AI 日程仍必须在后台完成
```

### 9.2 通用 Overlay Runtime 边界

`modules/android-overlay-runtime` 是无业务语义的 Android 窗口底座。当前由
Floating Interaction 与 Device Control 按需复用，但不拥有任一 Feature 的生命周期。

它只提供：

- Overlay 权限检查与系统设置页跳转；
- `TYPE_APPLICATION_OVERLAY` Window 的添加、更新和移除；
- system bars、display cutout、IME 等可用边界计算；
- 拖动、贴边、位置保存和可见区域约束；
- 点击后恢复指定页面的 launch intent。

通话执行与普通悬浮球不同时展示。Calls 原生宿主在本通执行期取得
`OverlayInteractionExclusion`，Floating Interaction 将其组合为独立的
`EXCLUSIVE_INTERACTION` 可见性抑制原因；通话结束或原生宿主销毁时释放。
订阅者晚 attach 也立即读取当前抑制状态。这个契约只隐藏窗口，不更改产品开关、
不停止 Overlay Service，也不触碰 Companion 的调度或执行。

底座接收原生 View 与窗口配置，不读取 SQLite，不调用模型，也不理解 RavenCat、
快捷聊天、截图、Soft Lock 或通话。各业务 Feature 必须保留独立的 Service、Controller、
View、通知文案与终态清理，不能把共享 Window primitive 扩张成万能 Overlay Service。

## 10. Native Module 物理边界

当前 `modules/ravencat-floating-layer` 同时容纳 Overlay UI/service、AI 日程 Alarm/Work 调度、恢复接收器与 Companion 执行请求与回执代码。物理共处不代表产品生命周期绑定：日程由 Companion 持有，Overlay FGS 由 Floating Interaction 持有。

当前没有独立的 `ravencat-companion-runtime` 模块。不要依据旧拆分草案创建新运行链或恢复已退役的单值 Self Wake 调度。修改原生文件时按实际 owner 维护窄边界。

## 11. 悬浮消息执行

native floating UI 将显式发送、截图和草稿清理提交到共享 `ApplicationExecutionHost`，
由 `executeFloatingMessage` 调用原有 Chat 窄端口并等待回复投影与终态回执。
Activity 或 React 页面不拥有执行生命周期，也不再创建悬浮消息专用 Service 或 RN task。
业务 signal 与截止点继续传入 Chat；取消时等待方收口，不留下悬挂预览等待。
持续后台保证由独立总开关提供，不属于 Floating Interaction 或 Companion。

## 12. Liveness 指示的边界

用户可以把悬浮球作为“App 后台宿主还活着”的肉眼信号，但实现不能反向依赖该信号。

禁止：

```text
if bubble not visible
→ assume database dead
→ assume proactive companion disabled
→ assume Accessibility off
```

Overlay Health 可以包括：

```text
serviceRunning
overlayForegroundServiceRunning
overlayAttached
bridgeConnected
```

`overlayForegroundServiceRunning` 只表示 Overlay FGS 自身在运行；Companion 的诊断必须使用自己的
`applicationBackgroundRunning`（独立总开关的持续后台运行），不得把 Overlay FGS 呈现成
「本地伴随前台服务」。

其他 runtime 各自报告自己的 health。

## 13. Settings 页面

建议悬浮窗设置只放功能本身：

```text
悬浮窗

开启悬浮窗                 ON

外观与行为
- 悬浮球皮肤
- 大小
- 透明度
- 贴边
- 休眠形态
- 初始位置

快捷操作
- Chat
- Extract
- Shot

系统访问
悬浮显示                   已开启 >
屏幕内容读取               已开启 >
```

系统访问行只是状态摘要和跳转，不在此页复制授权实现。

## 14. Factory Reset

恢复出厂可以清理：

- 悬浮球皮肤；
- 位置；
- UI 偏好；
- floating native diagnostics；
- floating-only pending task state。

不得尝试撤销 Android 系统授权。

## 15. 长期检查

Floating Layer 改动必须检查：

- 这项逻辑是否只有悬浮窗存在时才有意义？
- 悬浮窗关闭后，它是否本应继续工作？如果是，就不属于 Floating Layer。
- 是否把 proactive companion 又塞回 Floating Layer？
- 是否把 Accessibility 权限所有权塞进 Floating Layer？
- 是否改变了 Shot/Extract 的显式语义？
- 是否扩大了透明触摸区域造成实际遮挡？
- 是否把“球存在”误当成整个 RavenCat 健康？
- 是否让其他 Feature（尤其 Proactive Companion）依赖 Overlay FGS 的存活？
- `stopFloatingLayer()` / 关闭悬浮交互是否只影响 Overlay UI，没有触碰 Companion 的调度、执行或 SQLite 事实？
