# 手机工具当前契约

Phone Tools 是主理 AI 的手机能力产品面。产品目录、工具执行、系统权限与底层观察/动作各有 owner，不把它们合并成第二套 Runtime。当前 App-specific 工具包包括网易云和部分机型与版本适配的小红书文字笔记，不提前建设多 Provider 或 AI 委派平台。

应用工具包在手机工具页各有全局总开关，默认关闭、按需开启，设置由 Prompting 保存到 `prompt_default_switches` 的 `app_tool_package:<packageId>`。关闭时，Host 在生成本次授权集合前移除包内工具；目录、说明、拆包枚举和 schema 均不提供，已保存的星标与展开状态不能扩大授权。单项权限和星标偏好保留，重新开启后仍受主理身份与单项授权约束。设置对后续准备的运行生效，已开始的运行沿用冻结快照。

手机工具页使用目录中的图标类型、名称和介绍生成两行条目；共享开关与详情入口各自独立操作，卡片继续由 `ThemedSurface` 负责玻璃主题。新增应用包沿用同一总开关键空间，不增加应用专属的配置表。

## 1. 当前能力与所有权

| 能力 | 工具/入口 | 所有者 |
| --- | --- | --- |
| 环境感知 | search_installed_apps、get_foreground_app、get_app_usage、get_current_location | Device Observer / Phone Tools 的窄契约 |
| 剪贴板文字 | read_clipboard | Device Observer 的按需读取 / Phone Tools 授权入口 |
| 屏幕读取 | read_screen_accessibility、read_screen_ocr | Screen Observation（screenCapture） |
| 应用动作 | open_app、soft_lock_app、release_soft_lock | Device Control |
| 系统闹钟 | set_alarm、show_alarms、dismiss_alarm、snooze_alarm、get_next_alarm | Device Control 授权入口 / Android 系统时钟 |
| App-specific 数据与媒体 | 网易云八工具 | neteaseMusic 工具包及各底层 owner |
| 文字卡片笔记 | xiaohongshu_get_page 及逐步输入、导航、话题、发布工具 | Phone Tools 授权 / Device Control 原生页面适配 |
| 系统状态与授权 | 权限与后台运行 | System Access |

普通 AI 默认没有主理手机权限。执行时通过当前 Host Authority 确认身份，再由具体工具执行本地 policy；Prompt、目录、工具包展开和任务来源都不授予权限。不伪装 `isHostAI=true` 借出整套身份，不保留尚未实现的 scoped lease/协作会话作为当前接口。

AI 日程只提供自主执行机会，复用正常 Registry 与工具授权，没有 wake-specific 手机工具 adapter。增加工具不要求 Companion 再建立独立执行路径。

## 2. 产品目录不是执行权威

`PHONE_TOOL_CATALOG` 提供直接工具的分类、标题、说明和实现状态；`PHONE_TOOL_PACKAGE_CATALOG` 提供 App-specific 分组。它们不复制 Registry 的 schema、owner、risk、hostOnly、幂等或执行实现。

工具包是 discovery/grouping/presentation，不是代理执行工具。目录 available/planned 表示能力状态，不自动决定授权或详情是否能打开。页面只展示真实配置入口，App/Host 持有具体路由，Feature 表达导航意图。

手机工具与 App-specific 工具的单项调用权限由 Prompting 统一保存，提示词中心、手机目录及工具包详情共用同一份 AI 覆盖；Host 冻结授权时与其他内置工具使用相同解析链路。手机页面仅编辑当前主理 AI，未设置主理 AI 时不能修改调用权限；提示词中心的星标只控制已授权 schema 的直接暴露。

静态目录状态在页面表达为“已接入 / 开发中”，不再把实现完成显示为“可使用”。单项工具读取无障碍连接、页面读取/截图能力、使用情况访问、悬浮显示、通知使用权及定位授权/系统定位开关，显示当前缺失项或“权限就绪”；页面获得焦点及从系统设置返回时刷新。这个状态仅表达调用授权和系统前提，不预判目标 App 是否存在、Protected Apps、窗口可靠性、当前媒体会话或网络结果，也不成为新的执行门禁。

## 3. 受保护应用

用户和固定系统保护集合由 Phone Tools policy 合并、规范化与去重，观察和增加设备影响的动作共用该策略。当前用户集合仍有既有旧字段存储，由中性 Host composition 读取，不依赖 Companion 的初始化副作用。

| 行为 | Protected App |
| --- | --- |
| 获取前台/搜索安装应用 | 可知道身份和 protected 状态 |
| Accessibility、OCR、截图/视觉读取 | 拒绝内容访问 |
| 打开、软锁、App-specific 深度动作 | 拒绝新增影响 |
| release_soft_lock | 可撤销自己已创建的有效影响 |

策略在本地执行边界强制；模型是否遵守 Prompt 不能成为隐私边界。拒绝返回明确 `protected_app`，不伪装无文字、OCR 失败或未知窗口。保护 App 不等于隐藏它是否存在。

## 4. 应用身份与前台事实

search_installed_apps 从本机真实可启动列表解析 exact package，避免模型猜包名；搜索不是最终安全校验，动作 owner 仍拒绝不合法或不允许目标。

get_foreground_app 只消费 Device Observer 的 canonical 窗口事实；detectionReliable 且 package 存在才返回 identity/protected，否则 `foreground_app_unavailable`。它不读取标题、节点或页面内容，也不进入 Screen Observation 内容准入。

get_app_usage 按需读取今天、昨天或含今天的最近7天前台使用时长，可按 exact package 过滤，时长降序，默认最多20项、上限100项。未授权明确失败，不返回假零值；Android bucket 的真实起止时间随结果返回，不承诺精确切片，也不把后台音乐算作前台使用。没有持续监控或第二套唤醒。

get_current_location 按需请求一次 Android 系统融合定位，最多等待 15 秒，返回 WGS84 经纬度、精度（米）、实际测量时间、位置年龄、大致/精确授权及模拟位置标记。系统可能提供近期 fix，不能忽略时间或把大致位置说成精确位置。没有地址解析、持续追踪或位置存储；授权、定位总开关与 provider 在原生边界裁决，失败明确返回，工具不重复预检或回退到历史位置。用户从手机目录或权限页面主动申请使用期间的定位权限，不索取后台定位；后台调用仍受 Android 限制，权限就绪不承诺后台成功。该工具沿用主理身份、单项调用开关与星标，属于“手机环境感知”工具包。

`read_clipboard` 属于“手机环境感知”包，仅当前主理可用，沿用单项授权与星标。它只按需读取系统剪贴板首项的直接文字，原生边界最多返回 12000 个 Unicode 字符并标明截断，保留换行和空白。要求 RavenCat Activity 当前拥有焦点；后台日程或悬浮球不获得额外读取资格，也不自动拉起页面。Android 返回 null 时报告 `clipboard_unavailable`（可能为空或系统拒绝），没有直接文字时报告 `no_text`，不读取图片、文件、URI 或历史，不监听或缓存。内容作为外部数据交给模型，仍沿用工具结果的现有对话记录契约。

## 5. 安全屏幕快照

每次 Tool Call 在 freeze 前完成可靠窗口、Protected Apps 与 native fence；freeze 后只消费这一份绑定事实，不自动刷新、重试或切到新窗口。需要新状态时由模型发起新 Tool Call。

- read_screen_accessibility：有界语义 snapshot/plainText，密码值抑制；结构只补 clickable/editable/password 等必要元素，不暴露完整 node tree。结构区最多64行、单 label 最多160字。
- read_screen_ocr：复用截图准入与 fence，对冻结 bitmap 执行 bundled ML Kit 中文识别，返回有界正文，在返回前释放临时截图，不暴露 URI。
- 无文字是明确的成功 no_text，不偷偷换感知方式。Accessibility、OCR 与真正视觉理解不是互相隐藏 fallback。

具体结果、native cache 与隐私见[屏幕观察契约](screen-observation.md)。工具只投影可信 snapshot，不重复底层已保证的窗口或参数校验。

## 6. open_app

open_app 只接受 exact Android package，经过当前 Host Authority、输入与 Protected Apps 准入，调用 Device Control 的 API 33 front-door launch。单次调用最多一次 launch request，不内部搜索、重试或读取前台确认。

`launch_dispatched` 只代表请求交给 Android，不证明目标已经成为前台。需要解析和确认时，由模型独立组合 search_installed_apps、open_app、get_foreground_app，不把 URL、songId 等深度参数塞进万能 open_app。

## 7. 系统闹钟

`set_alarm` 属于“手机应用操作”包，仅当前主理 AI 可用，手机工具页、提示词中心共用单项授权与星标。模型参数在唯一 Runtime schema 边界校验：本地 24 小时时分、可选名称、可选 ISO 星期数组（1=周一、7=周日）；省略或空数组表示下一次该时分的一次性闹钟，否则按周重复。不接受日期，不能把任意未来日期伪装成下一次响铃。

工具在 Host Authority 串行边界内检查取消并派发一次 Android `AlarmClock.ACTION_SET_ALARM`，原生主线程要求 RavenCat Activity 拥有焦点，避免后台启动被静默拦截后误报。声明普通 `com.android.alarm.permission.SET_ALARM` 权限，不申请精确闹钟、日历、无障碍或后台保活权限；请求 `EXTRA_SKIP_UI=true`，但具体时钟仍可能展示确认界面。`alarm_request_dispatched` 仅表示启动请求已派发，没有保存回执或可用的闹钟 ID；无时钟、非前台、系统拒绝分别明确失败，不自动重试。响铃、编辑、关闭及删除由系统时钟管理，不写 RavenCat SQLite，不创建 AI 日程或 Service。接口依据 [Android AlarmClock 契约](https://developer.android.com/reference/android/provider/AlarmClock#ACTION_SET_ALARM)。

闹钟仅使用 Android 公开接口，不做厂商时钟或无障碍适配。所有闹钟工具沿用主理身份、单项权限与星标，归入“手机应用操作”包。手机目录与模型 schema 都说明以下边界：

| 工具 | 实际能力与限制 |
| --- | --- |
| `show_alarms` | 请求打开系统时钟闹钟页面供用户管理；不读取或返回列表。 |
| `dismiss_alarm` | 请求取消下一次响铃；一次性闹钟停用，重复闹钟仅跳过下一次。可按 next、all、label、time 搜索；all 也不会删除或永久关闭重复闹钟。标签是包含匹配，时分是最接近匹配，多条匹配时系统可能要求用户选择。时间传入本地 24 小时制，原生转换为小时与 AM/PM，避免含糊。 |
| `snooze_alarm` | 请求当前响铃闹钟稍后再响，可指定本次分钟数；省略使用时钟默认值，不修改默认配置，无响铃时无操作。 |
| `get_next_alarm` | 读取当前用户由任意应用通过 `AlarmManager.setAlarmClock` 登记的下一个触发时间；可后台查询，不返回名称、ID、重复规则或完整列表。not_scheduled 不能证明时钟里没有停用或未登记闹钟。 |

前三项动作与设置闹钟共用原生前台焦点和单次派发边界，接收方不支持时明确失败；`alarm_request_dispatched` 没有完成回执，不能宣称已删除、已修改或已成功取消。Android 标准接口未提供读取全部、编辑、永久删除已有闹钟，因此不注册这些名称，也不通过新增闹钟冒充编辑。依据 [AlarmClock](https://developer.android.com/reference/android/provider/AlarmClock) 与 [getNextAlarmClock](https://developer.android.com/reference/android/app/AlarmManager#getNextAlarmClock())。

## 8. 按需拆包与主动开关

Host 在一次 run 开始冻结授权，通过固定目录提供包 ID、用途与本次可用工具名；具体 description/参数只在当前请求的 function schema 提供。目录与历史之后的 open/closed 状态分离，展开不改稳定前缀，详见[默认 Prompt 组装](../prompt/default-prompt-assembly.md)。

```text
固定用途目录 + open_tool_package / close_tool_package
→ 展开包
→ 下一次模型请求提供原始 child function schema
→ 模型直接调用原始工具
→ 唯一 Runtime 校验并执行
```

拆包当轮可继续使用多个包，但同一批不能先拆包再猜参数调用 child，必须等下一请求的 schema。重复展开不续期；旧 phone_package_list_tools/call_tool 已退出生产。MCP 的两个 meta-tool 仍属于自身远端受控调用契约。

普通单聊的 `chat_tool_package_exposure` 属于 Chat，以会话/AI/包为键；开关与正式 T3 回复同事务提交，行存在即持续展开，不按轮数到期。不再需要时由 AI 调用 `close_tool_package`，之后可重新打开。多次开关按实际执行顺序保存，失败/取消/supersede/fence/回滚不改变持久状态。通话、旁路和自主任务的开关只在当前 run 生效。

展开与本轮已授权工具相交，不能复活关闭权限的工具。用户特批星标是按 AI 固定的直接暴露偏好：只有本轮已授权工具才直接带 schema，不受包收起操作影响，星标不授予调用权限。

## 9. 展示、网易云与验证

小红书工具的输入、区域坐标、一次发布凭据及真机验证边界见[小红书文字笔记](xiaohongshu-text-note.md)。这条链路不改变现有剪贴板读取权限；粘贴只写入 AI 已提供的单个话题，不在后台读取用户剪贴板。

Chat 保存原始 runtime tool identity，只在 presentation 映射 `cloudmusic.*` 等名称；可见别名不参与授权。旧历史调用仍可显示，但不重新注册退休 meta-tool。

网易云当前八工具、公开数据、官方 App 点歌和 exact-package MediaSession 见[工具包契约](netease-music-tool-package.md)。一起听是[独立 Activity](together-listening.md)，不属于该包或播放检测的自动副作用。

相关验证保护 Host 身份、Protected Apps、冻结快照、launch 一次、schema、展开期与 Chat 原子提交。真实 Accessibility/OCR、OEM 窗口、音乐网络/MediaSession/权限撤销需设备验收。未实现的 AI 委派、协作会话与其他 App 集成不进入当前产品承诺。

`npm run verify:system-alarm` 验证闹钟参数、主理身份、取消、原生参数与结果映射；Device Control 的 `SystemAlarmControllerTest` 在 JVM 验证实际 Intent、星期转换、焦点限制与明确失败。具体机型时钟是否保存、跳过界面和锁屏响铃仍需设备验收。
