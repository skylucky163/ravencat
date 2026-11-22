# 应用更新与下载来源

`GitHubReleases.fetchApplicationReleases` 匿名读取 `skylucky163/ravencat` 最近 100 条 GitHub Release。网络请求有 15 秒超时，不重试；在这一边界验证响应结构，仅交付已发布且具有上传完成的 APK 的版本。包含 Pre-release，不使用会排除预览版的 `/releases/latest`。

发布标签使用 `v主版本.次版本.补丁版本`，也支持语义版本的预发布后缀与构建元数据。Host 按安装包的原生版本名比较，选择更高的可下载版本；同版本、较旧版本、无 APK 的版本和草稿不提示。发布新版 APK 时需同时提高安装包版本名与 Release 标签；仅提高构建编号不会产生升级提醒。

开发环境（React Native `__DEV__`）由 Metro 交付代码，不参与公开 APK 更新检查；手动点击时说明开发版的更新方式，不查询 GitHub。开发包与公开预览包的包名和签名独立，原生改动需重新安装开发包。预览／发布环境继续按已安装 APK 的版本检查更新。

Host 在每次冷启动进入前台后检查，不阻塞启动与数据恢复。网络失败不会宣称“已是最新版本”，用户可在设置中手动重试。选择“跳过此版本”将版本号保存到 AsyncStorage，同版本下次不自动弹窗；可用更新仍留在设置入口并显示红点，手动检查仍可打开该版本，新版本再次自动提醒。清空数据会同时清空跳过记录。更新状态不参与 Tab 栏未读数，不调用 Android 通知。

更新弹窗提供“GitHub 下载”和“Gitee 国内下载”，共用下载状态、进度、跳过记录和安装流程，不自动切换来源或重试。GitHub 下载原 APK；Gitee 使用同一原始标签下的 `RavenCat-<版本>-download.zip`，地址为 `https://gitee.com/skylucky163/ravencat/releases/download/<标签>/RavenCat-<版本>-download.zip`。Gitee 发行版需要单独发布该附件，源码或标签同步不代表附件已就绪；附件缺失时提示用户稍后重试或手动选择 GitHub。

网络下载由已有 Expo 文件模块写入应用专用 cache 的 `app-updates/`，进度按实际下载响应的长度计算。`modules/app-updates.prepareDownloadedUpdate` 负责本地文件准备：国内 ZIP 仅将根目录下约定的 `RavenCat-<版本>.apk` 流式提取到固定缓存文件，不展开其他条目、不使用条目路径创建文件；实际解压输出不能超过 GitHub 公布的 APK 大小。两个来源随后统一在原生文件边界核对 GitHub asset 的 SHA-256、文件大小、包名和版本，不信任 ZIP 内附带的校验清单作为安装依据。失败清除 ZIP 和 APK，成功移除 ZIP，只保留已校验的 APK，不要求用户手动解压。

下载完成后提示用户点击“安装更新”，通过已有 Expo FileProvider 授予安装器单文件读取权限，打开 Android 系统安装确认页。覆盖签名与安装许可由 Android 安装器负责。版本发现仍依赖 GitHub API，增加国内下载入口并不提供完全独立于 GitHub 的更新检查。

首次安装更新需要系统“允许安装未知应用”授权；返回后点击检查更新即可继续安装，不重复下载。尚未安装的包在本次进程内保留可安装状态；进程重启后重新检查、重新下载，不提供跨进程续传或后台服务。新的 APK 必须包含对应版本的 `app-updates` 原生模块；ZIP 自动解压同样需要新版 APK，已经发布的旧 APK 无法仅通过服务端配置补上这些功能。

“发现 → 权限与后台运行 → 应用更新”显示“安装未知应用”的实际系统授权状态，点击可打开本应用的授权页；返回应用后沿用权限页面的 AppState 刷新。通知使用权复用 Device Control 已有的 NotificationListener 授权状态与系统设置入口，权限页面明确展示它，不与通知发送开关混用。

验证：`node --no-warnings tests/profile/verify-application-updates.mjs`；原生 APK 文件校验执行 `android/gradlew.bat :app-updates:testDebugUnitTest`。权限返回刷新与系统安装确认需用新原生包真机验收。
