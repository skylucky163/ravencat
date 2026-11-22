# 本地开发

RavenCat 使用 React Native、Expo SDK 54 和 TypeScript，原生部分使用 Kotlin。项目仅支持 Android 13 及以上，不支持 Expo Go。

## 准备环境

- Node.js 22，版本范围为 `>=22.23.4 <23`；`.nvmrc` 提供参考版本。
- npm；安装时使用仓库的 `package-lock.json`。
- Android Studio、Android SDK、JDK 17，以及可用的 `adb`。
- 开启 USB 调试的 Android 13+ 手机，或对应版本的模拟器。

```powershell
npm ci
```

安装后会自动应用 Expo 开发壳保活、原生共享对象注册表并发读取、SQLite 关闭补丁，以及 React Native 固定字号策略。不要使用 `--ignore-scripts` 跳过这些步骤。

## 应用字号

应用文字和行高按设计值固定，不跟随 Android 系统的字体大小设置。RN 的 `Text`、`TextInput` 在 `scripts/patch-react-native-font-scaling.cjs` 中统一关闭 `allowFontScaling`，第三方 Markdown 等组件也经过同一文本底座；React 19 不支持用函数组件的 `defaultProps` 实现这个全局策略。

原生自绘界面的 `TextView`、`EditText` 使用 `setTextSize(TypedValue.COMPLEX_UNIT_DIP, 字号)`，保持与布局相同的密度单位。系统通知栏、权限弹窗等系统绘制的界面仍由 Android 管理。本策略只固定文字大小，不替换系统字体样式。

升级 React Native 后需检查上述文本入口。补丁发现入口变化时会直接失败，不静默跳过。验证命令为 `node tests/ui/verify-fixed-font-size.cjs`。

## 开发安装包

第一次开发需要生成 Android 工程并安装包含本地原生模块的开发版；单独启动 Metro 不会安装应用。

```powershell
$env:EAS_BUILD_PROFILE = 'development'
npx expo run:android
```

这一步会实际编译并安装开发 APK，请按需手动执行。开发版名称为 KimiPhone，包名为 `com.skylucky.kimiphone.dev`；常规构建名称为 RavenCat，包名为 `com.skylucky.kimiphone`。

`android/` 由 Expo 生成。仓库目前只跟踪其中的 `gradle.properties`，不能把它当成完整 Android 工程；克隆后通过 Expo 生成其余文件。修改原生配置时，应优先修改 `app.config.js`、`plugins/` 或 `modules/` 中的源配置。

## 连接手机与 Metro

### USB 或模拟器

```powershell
adb reverse tcp:8081 tcp:8081
npm start
```

`npm start` 默认使用开发客户端和 localhost，不要求安装 Tailscale。USB 反向端口将手机上的 8081 连接转到电脑；随后在已安装的开发版中连接开发服务器。

这里的 localhost 是客户端连接地址，不是服务器访问控制。当前 Expo SDK 54 的 Metro 实测仍监听所有网卡；需要禁止其他设备连接时，应通过电脑防火墙限制开发端口，不能只依赖 `--localhost`。

### 同一局域网

```powershell
npx expo start --dev-client --lan
```

电脑和手机需要互相可达，防火墙需要允许相应连接。局域网模式用于你信任的网络。

### Tailscale（可选）

Tailscale 只是一种开发网络连接方式，不是 RavenCat 的运行依赖。电脑和手机加入同一个 tailnet 后，在当前 PowerShell 会话中指定自己的电脑地址：

```powershell
$env:REACT_NATIVE_PACKAGER_HOSTNAME = '<电脑的 Tailscale IPv4 地址>'
npx expo start --dev-client --lan
```

该环境变量控制开发客户端使用的连接地址，**不负责限制服务器监听的网卡**。需要仅允许 tailnet 访问时，在电脑防火墙和 Tailscale 访问规则中限制 8081 端口。不要把个人地址写入公共 `metro.config.js`，也不要把“检测到 Tailscale 网卡”当成访问隔离。

结束后清除当前会话的变量：

```powershell
Remove-Item Env:REACT_NATIVE_PACKAGER_HOSTNAME
```

Expo 的连接参数见[官方 CLI 文档](https://docs.expo.dev/more/expo-cli/)。

## EAS 云构建（可选）

本地开发无需 EAS 项目。使用云构建时，登录自己的 Expo 账号并创建自己的项目，再把 `.env.example` 复制为 `.env.local`，填写 `EAS_PROJECT_ID` 和 `EAS_PROJECT_OWNER`。

```powershell
Copy-Item .env.example .env.local
```

已有 `.env.local` 时不要覆盖。两项变量仅用于构建账号关联，不是应用中的模型凭据。`eas.json` 提供 development、preview、production 配置；项目关联变量还应配置到相应 EAS 构建环境中，以便远端解析 `app.config.js`。

API Key、语音服务和 MCP 认证信息通过应用设置输入，不写入源码或上述环境变量。

## 本地 preview 与云端覆盖更新

Android 覆盖更新要求包名和签名证书一致，且新包的 `versionCode` 不低于已安装版本。本地和云端 preview 都使用 `com.skylucky.kimiphone`；开发版 `.dev` 是独立应用，数据也独立。

本地 release 通过 `plugins/withAndroidReleaseSigning.js` 读取项目根目录的 `credentials.json`，使用与 EAS 相同的凭据格式。缺失签名时 release 直接失败，不使用 debug 签名；开发版仍可正常构建。云端仍使用 EAS 管理的凭据，不需要修改 `eas.json`。

首次配置时，在已关联原云端项目的工作目录执行：

```powershell
$env:EAS_BUILD_PROFILE = 'preview'
eas credentials --platform android
```

选择 `preview`，进入 `credentials.json: Upload/Download credentials between EAS servers and your local json`，再选择 `Download credentials from EAS to credentials.json`。必须下载原 preview 已有的密钥，创建新密钥无法覆盖已有应用。操作说明见 [Expo 凭据同步文档](https://docs.expo.dev/app-signing/syncing-credentials/)。

下载的 `credentials.json` 和 keystore 均已被 `.gitignore` 排除。请将 keystore 保存在 `android/` 之外，例如项目根目录的 `keystores/`，并同步修改 `credentials.json` 中的 `keystorePath`，避免重新生成原生工程时丢失它们。密码只留在本地凭据文件中，不写入源码。

之后可以手动构建无需 Metro 的 preview APK：

```powershell
$env:EAS_BUILD_PROFILE = 'preview'
$env:NODE_ENV = 'production'

# 首次生成、切换 profile，或修改原生配置、插件、图标及原生依赖后执行；日常业务代码改动可跳过。
npx expo prebuild --platform android --no-install
if ($LASTEXITCODE -ne 0) { throw 'Android prebuild 失败' }

Push-Location android
try {
    .\gradlew.bat :app:assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'Android release 构建失败' }
} finally {
    Pop-Location
}

adb install -r ".\android\app\build\outputs\apk\release\app-release.apk"
if ($LASTEXITCODE -ne 0) { throw 'APK 安装失败' }
```

APK 位于 `android/app/build/outputs/apk/release/app-release.apk`。上述命令会实际构建并安装；只检查签名配置时，将 Gradle 任务换成 `:app:validateSigningRelease :app:signingReport`，并跳过 `adb install`，不会打包 APK。已有原生工程也要先执行一次 prebuild，让签名插件生效。

Expo SDK 54 的 prebuild 更新 `package.json` scripts 时不区分目标平台，即使指定 `--platform android`，缺失 `ios` script 也会被补为 `expo run:ios`，并触发整个 JSON 的重新排版。`--no-install` 仅跳过依赖安装，`--skip-dependency-update` 也不控制 scripts。项目保留一个明确报错退出的 `ios` script，声明不支持 iOS，同时避免每次 prebuild 都补回构建入口；Android 平台范围仍由 `app.config.js` 的 `platforms: ["android"]` 和 prebuild 参数负责。参见 [Expo SDK 54 的 scripts 更新实现](https://github.com/expo/expo/blob/sdk-54/packages/%40expo/cli/src/prebuild/updatePackageJson.ts)。

Android 自适应图标在 development 使用透明的 `assets/adaptive-icon.png` 作为前景并配白底，preview／发布版使用 `assets/icon.png` 作为前景并配黑底；通用图标仍为 `assets/icon.png`。`plugins/withAndroidDevelopmentIcon.js` 在每次 prebuild 时生成 `src/debug/res` 中的开发版前景和白色背景，确保 preview 原生工程直接构建 debug 时也使用开发版图标；不能只覆盖底色，因为 `icon.png` 的不透明黑底会盖住它。`plugins/withAndroidReleaseIcon.js` 生成 `src/release/res` 中的自适应图标，前景四边各内缩六分之一，将完整图片缩到中央 72dp 区域，保留 logo 原有边距；该覆盖仅用于 preview／发布构建，不改变 debug 图标。启动屏由 `expo-splash-screen` 插件配置为黑底，居中显示 `assets/icon.png`，图像宽度为 200；实际效果以 release 构建为准。修改图标、Expo 原生配置或切换构建 profile 后，先设置对应的 `EAS_BUILD_PROFILE`，再运行不带 `--clean` 的 prebuild，将配置同步到 `android/`；仅修改业务 TypeScript / JavaScript 时，可以直接执行 Gradle 构建。保留 `android/` 和 Gradle 缓存时，未变化的任务可以复用上次输出，通常显示 `UP-TO-DATE`；不需要每次重新生成原生工程或执行 `clean`。详见 [Gradle 增量构建说明](https://docs.gradle.org/current/userguide/incremental_build.html)。

确认新包与手机上已安装应用的签名相同后，可以直接覆盖安装并保留应用数据。若当前安装的是旧的本地 debug 签名版，则需要先导出备份，再手动卸载旧版、安装统一签名的新包并导入备份；Android 权限需重新授权。切换完成后，本地与云端 preview 就可继续覆盖更新。Android 更新规则见 [官方说明](https://developer.android.com/google/play/app-updates)。

### 依赖下载超时

多个任务同时出现 `Could not download` / `Read timed out` 时，先确认报错中的依赖地址是否可访问；任务名包含 `checkReleaseDuplicateClasses` 并不代表发生了重复类冲突。

需要代理时，在用户级 `%USERPROFILE%/.gradle/gradle.properties` 配置 `systemProp.http.proxyHost`、`systemProp.http.proxyPort`、`systemProp.https.proxyHost` 和 `systemProp.https.proxyPort`，使用代理客户端的实际 HTTP 端口。Gradle 通过 JVM 系统属性配置代理，详见 [Gradle 网络文档](https://docs.gradle.org/current/userguide/networking.html)。个人网络配置不写入仓库的 `android/gradle.properties`，也不传到 EAS 云端。

配置后保持代理客户端运行，继续原构建命令即可复用已完成的任务；不需要执行 `clean` 或删除 Gradle 缓存。

## 应用版本

主版本只修改根目录 `package.json` 的 `version`。Expo 配置和 Android 构建读取同一来源；构建编号由 `scripts/app-version.cjs` 按构建时刻生成。`plugins/withAppVersion.js` 负责将这项约定接入生成后的 Android 工程。

开发版加载 Metro 新代码后，已安装 APK 的版本名和构建编号保持不变。「我」页分别展示开发源码版本与安装包版本；源码版本不随每次提交自动递增。开发环境不检查 GitHub 公开 APK 更新，原生改动需要重新安装开发包。

## 修改后验证

只执行与改动有关的检查，不需要为文档或配置修改构建完整 APK。

```powershell
npm run typecheck
npx eslint <修改的文件>
```

业务验证和架构检查入口在 `package.json`，选择涉及的模块运行即可。核心契约验证依赖 Node.js 内置 `node:sqlite`，需要上述 Node.js 版本。

测试代码在 `tests/`，目录与 `src/` 同构。新增、移动测试或调整入口后：

```
npm run verify:registration   # 未注册的测试文件、指向不存在文件的入口
npm run verify:all            # 全部叶子入口，默认跳过 Gradle 与外网条目
```

目录规范、共享夹具用法和验收流程见 [tests/README.md](../tests/README.md)；约束条文见 [AGENTS.md](../AGENTS.md) §12。

## 代码导航

| 目录 | 用途 |
|---|---|
| `src/app/` | 页面路由 |
| `src/host/` | 跨模块装配与运行时组合 |
| `src/features/` | 聊天、记忆、通话、陪伴等业务功能 |
| `src/platform/` | 模型调用、SQLite、Android 等技术能力 |
| `src/shared/` | 主题、通用组件和公共工具 |
| `tests/` | 验证脚本，目录与 `src/` 同构 |
| `scripts/` | 构建补丁、版本生成、文档生成器与外网探针 |
| `modules/` | 本地 Android 原生模块 |
| `plugins/` | Expo 原生配置插件 |

开发约束见 [AGENTS.md](../AGENTS.md)，定位入口见[架构导航](architecture-navigation.md)，更细的实现说明在对应模块的 README 中。
