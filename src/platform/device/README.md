# Android 设备能力

本目录提供跨 Feature 的 Android 通知、媒体选择、本地文件、持久化媒体、实时语音采集，以及普通语音片段录制/播放能力。

## 公共入口

- 业务代码从 `@platform/device` 导入通用设备能力；
- 界面需要图片或附件操作时，可从 `@platform/device/DeviceMediaService` 导入媒体门面；
- Feature 专属的原生适配仍放在对应 Feature 的 `infrastructure/`。

本目录只承载技术能力，不包含聊天、通话、朋友圈或主动联系策略。

`saveImageToGallery` 接收已经过图片入口检查的本地 URI 与真实 MIME，通过 `modules/gallery-writer` 写入系统相册 `Pictures/RavenCat`，不读取或申请相册权限。命名使用本地时间与内容 hash 前八位，扩展名来自真实 MIME；原始字节直接复制，GIF／WebP 动画不转码。原生边界只允许应用 files/cache 中的文件，`IS_PENDING` 发布与取消互斥，失败删除 pending 记录，并区分空间不足、目录不可写和写入中断。公开相册文件不归私有媒体清理、备份和恢复出厂管理。

`Clipboard.readDeviceClipboardText` 在 Android 主线程按需读取首项直接文字，要求当前 Activity 拥有焦点；不获取焦点、不监听、不读取历史或解析 URI。原生边界限制为 12000 个 Unicode 字符并标明截断；系统返回 null 时明确表示内容不可用，不断言剪贴板为空。现有 UI 写入继续使用 `copyTextToClipboard`。

`DeviceLocation` 提供定位授权/系统开关查询、用户主动触发的使用期间权限申请，以及一次系统融合定位。原生单次请求最长 15 秒，保留测量时间、位置年龄、精度和模拟位置标记；支持大致授权，不解析地址、不保存或持续监听位置、不申请后台权限，也不依赖无障碍或悬浮服务。

`DeviceStatus` 提供按需电池快照与应用使用统计，对应 Device Observer 原生模块，但不依赖无障碍服务连接。电量无需权限；应用使用统计需系统“使用情况访问”授权，查询前在原生边界检查当前授权及用户解锁状态。统计为 Android `UsageStatsManager` 聚合的前台时长，保留真实统计区间，不包含后台音乐播放，也不持续监听、保存使用历史或启动服务。

`DeviceStatus.getInstalledApplicationInfo` 同步读取自身安装包的名称、版本名称和构建编号，
无需权限或服务连接。界面展示安装版本时使用这些原生事实，不从 Metro 的 Expo 配置猜测安装包版本。

`DeviceMediaService.pickCroppedImage` 复用 Expo 的 Android 原生选图与裁剪，返回裁剪后的临时图片或取消结果。调用方申请权限并指定比例：头像 1:1、时刻封面 16:9、背景使用当前屏幕比例；业务 owner 继续负责持久化与绑定。`plugins/withImageCropColors.js` 为生成的 Android 工程配置深浅色实色顶栏与高对比度图标，修改这些原生资源需要重新编译应用。

`cropImageToAspect` 提供无交互的自动裁剪：输入本地图片 URI 与目标宽高比，默认居中裁剪，只缩小不放大、不拉伸、不改动原图，不弹任何界面。文件检查复用 `inspectLocalImage` 契约；动态图沿用 `prepareVisionImage` 的静态帧契约，输出恒为单帧并通过 `sourceWasAnimated` 告知来源。成功的临时文件归调用方使用并清理，动态图的静态帧等中间产物由函数自身清理。`node scripts/verify-image-auto-crop.mjs` 验证横竖互换、同比例、小图不放大、动态图单帧与失败清理。

聊天的「上传图片」由 `selectChatImages` 使用 `expo-image-picker` 的标准 Photo Picker 入口多选图片，张数上限由 Chat 草稿 owner 传入，当前为 9 张；`quality: 1` 且不编辑，让 Expo 直接复制原始字节。逐张取实际缓存文件大小，不信任媒体索引的声明大小，保留单图 5 MiB 限制；尺寸使用 Expo 从缓存文件取得的结果。「上传文件」使用文档选择器，两者进入同一附件持久化和视觉输入链路。`npm run verify:chat-image-selection` 验证多图顺序、原图读取配置、逐张实际大小、文件名、取消与错误传播。

真机曾出现系统媒体索引大小 345664 字节、物理原图 346230 字节的异常条目。原生日志确认 Picker 提供的句柄和源流只有 345664 字节，Expo 缓存与源流哈希一致，截断发生在系统提供路径。只重新扫描该原图的系统索引后，同一 URI 的句柄和读取长度恢复为 346230 字节，缓存与原图逐字节一致，DeepSeek 识别成功。错误索引的产生原因尚未确认；此次重扫描是单条系统记录的诊断与修正，产品代码没有自动重扫描。`legacy: true` 对照仍由 Photo Picker 接管、仍然截断，现已移除该无效选项；标准入口在修正索引后的真机回归仍待确认。不设置失败后切换、重试或转码。

相册原生诊断由 `scripts/patch-expo-image-picker-diagnostics.cjs` 补充：在选择器调用失败处记录完整 Java 异常链、线程名和是否主线程，随后原样抛出。开发版还在 JPEG 原有的那一次复制中记录源 URI、authority、文件句柄大小、实际读取字节数及 SHA-256，导出后记录 legacy 模式、提供器声明大小和缓存大小。源流不重复打开，复制失败仍原样传播；句柄大小的诊断失败只记录警告，不干预复制。缓存和持久化文件可按日志中的路径拉取，独立比较哈希及 JPEG 结束标记，不将标记检查加进产品流程。补丁不改变面板、启动线程或重试行为；随 `postinstall` 应用，需重新编译原生应用才能在设备生效。使用 `adb logcat -v threadtime RavenCatImagePicker:V '*:S'` 获取日志。

Expo SDK 54 的 Activity 合约通过 `scripts/patch-expo-activity-results.cjs` 修正：React Native 新架构保留运行时并重建页面时，旧页面销毁可能没有传递到 AppContext。恢复时按实际 Activity 身份交接相册、相机和裁剪入口，不仅依赖销毁通知；同一页面从后台恢复不重复注册。补丁随 `postinstall` 应用，需重新编译原生应用才能在设备生效。`npm run verify:expo-activity-results` 在 JVM 验证真实 Expo 生命周期和结果回调，不生成 APK。

Chat 语音消息使用 `VoiceRecording`、`LocalAudioPlayback` 与 `LocalAudioMetadata` 三个窄端口，对应 `modules/voice-message-audio`。录音输出 16 kHz、单声道、PCM16 WAV；播放使用 Android 普通 `USAGE_MEDIA + CONTENT_TYPE_SPEECH`，提供 started、暂停/继续、进度、结束和错误事件。Calls 的通信路由、AEC 与半双工语义仍由 Calls 私有模块持有，不能经这些端口隐式复用。
