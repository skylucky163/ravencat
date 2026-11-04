# 第三方软件声明

本文件说明 RavenCat 使用的第三方软件、许可原文来源和当前清单的覆盖范围。项目原创代码、文档与已确认的原创图片采用 MIT，不改变第三方组件的授权条件。中文用于说明，上游版权和法律条款保留原文。

## npm 依赖

实际版本来自 `package-lock.json`，不是 `package.json` 中的版本范围。

- [直接依赖表](third-party/npm-direct-dependencies.md)：全部直接运行依赖与开发工具的版本、许可及来源链接。
- [完整依赖清单](third-party/npm-inventory.json)：锁文件内的直接、传递和跨平台可选依赖。
- [许可原文汇编](third-party/npm-notices.txt)：收集到的版权、LICENSE、NOTICE 等文本。
- [许可原文收集缺口](third-party/npm-notice-gaps.md)：已安装但尚未收集到完整原文的包，按当前结果生成。

清单由下面命令生成，不会安装新依赖或改变锁文件：

```powershell
node scripts/generate-third-party-notices.mjs
```

请先执行 `npm ci`，避免本地安装版本与锁文件不一致。生成器记录包内许可文件，包括 `MIT-LICENSE.txt` 等常见命名；Expo、React Native 和 Metro 的部分发布包未附仓库根许可，已根据它们明确的仓库归属补充保存的上游原文，并记录来源。其他补充快照明确绑定已核对的包名和版本，原文来自 npm 发布记录指向的固定 commit、对应版本 tag，或该版本发布包的 README／源码许可段落。上游地址与版本范围见 [sources.json](third-party/upstream/sources.json)，升级依赖时也应复核这些快照。

当前锁文件共有 1197 个包条目。本次 Windows 安装中，37 个跨平台可选包未安装，23 个已安装包尚未收集到完整许可原文，均在清单中以 `installed`、`noticeFiles` 标明。2026-10-10 核对补齐了其中 12 个包的原文；另保留网易云参考实现的许可。许可证名称来自包元数据，不能替代缺失的版权和许可文本；这些缺口应在分发相应组件前补齐。它们不应被误标为“无许可证”。

首次公开的源码快照不包含 `node_modules/`、APK 或这些依赖的构建产物。上述清单用于记录安装依赖与收集状态；发布安装包或直接携带第三方组件时，再按实际包含的范围核对并提供对应声明，不能把源码快照与完整安装包的分发范围混为一谈。

lockfile 的 `dev` 标记与 APK 实际打包范围不是同一回事，例如 Expo 工具链依赖可能被 npm 标为非 dev。不要根据清单行数断言 APK 含有全部组件。

### 图标与字体

- `lucide-react-native` 自带 ISC 许可和作者声明，已收集到 npm 许可原文中。
- `@expo/vector-icons` 包装代码采用 MIT；当前源码实际使用其中的 Ionicons 字体。字体本身也有上游许可，另保留 [Ionicons MIT 原文](third-party/upstream/ionicons-7.4.0-LICENSE.txt)。文件名表示许可文本的来源标签，不是对 Expo 内置字体版本的识别。
- 如果以后使用其他图标集或加入字体，请按对应字体许可补充声明，不能仅引用包装代码的 MIT。

### 需要单独注意的传递依赖

清单中包括 MPL-2.0 的 Lightning CSS 及相关平台包、开发工具中的 `postcss-values-parser`，以及 CC-BY-4.0 的 `caniuse-lite` 数据。另有采用双许可证或多许可证选择的包；原始表达式保留在清单中。分发这些组件时应按其实际许可处理，不能概括为“全部 MIT”。

## Android 原生模块显式依赖

以下内容来自 `modules/*/android/build.gradle`，覆盖本地模块显式声明的第三方运行依赖。React Native、Expo、Kotlin、Android Gradle 工具链及这些组件的传递依赖还会由 Gradle 解析；本表不是最终 APK 的完整依赖解析清单。

| 组件 | 声明版本 | 许可或条款 | 引入用途 |
|---|---|---|---|
| `com.qmdeve.liquidglass:core` | `1.0.3` | MIT | 液态玻璃渲染 |
| `com.squareup.okhttp3:okhttp` | `4.12.0` | Apache-2.0 | 原生网页请求 |
| `org.jsoup:jsoup` | `1.21.2` | MIT | 网页内容解析 |
| `com.caverock:androidsvg-aar` | `1.4` | Apache-2.0 | 悬浮层 SVG 渲染 |
| `androidx.core:core-ktx` | `1.13.1` | Apache-2.0 | Android 基础扩展 |
| `androidx.core:core-telecom` | `1.0.0` | Apache-2.0 | 通话集成 |
| `androidx.camera:camera-camera2` | `1.4.2` | Apache-2.0 | 相机 |
| `androidx.camera:camera-lifecycle` | `1.4.2` | Apache-2.0 | 相机生命周期 |
| `androidx.camera:camera-view` | `1.4.2` | Apache-2.0 | 相机预览 |
| `androidx.lifecycle:lifecycle-runtime` | `2.8.7` | Apache-2.0 | 原生生命周期 |
| `androidx.work:work-runtime` | `2.8.0` | Apache-2.0 | 后台任务 |
| `com.google.mlkit:text-recognition-chinese` | `16.0.1` | Google ML Kit / Google APIs 条款 | 中文 OCR |
| `com.github.gkonovalov.android-vad:webrtc` | `2.0.10` | MIT（Android 封装）与 BSD（WebRTC VAD） | 通话本地人声检测 |
| `com.facebook.react:react-android` | 由 React Native 工程解析 | MIT，另含各自许可的第三方组件 | React Native 原生接口 |

测试还使用 JUnit `4.13.2`（[EPL-1.0](https://github.com/junit-team/junit4/blob/r4.13.2/LICENSE-junit.txt)）、Robolectric `4.14.1`（MIT）、`org.json:json:20240303`（该版本的上游 [Public Domain 声明](https://github.com/stleary/JSON-java/blob/20240303/LICENSE)）和 WorkManager 测试组件；这些不因仅用于测试就变成项目原创代码。

### 液态玻璃

本项目通过本地 Expo 模块封装 [QmDeve/AndroidLiquidGlassView](https://github.com/QmDeve/AndroidLiquidGlassView)。当前固定使用 `com.qmdeve.liquidglass:core:1.0.3`，版权所有：Copyright (c) 2025-2026 Donny Yale。完整 [MIT 原文](third-party/upstream/liquid-glass-1.0.3-LICENSE.txt)随本目录保存。

选择 `1.0.3` 是因为该版本以 compileSdk 36 发布，符合当前 Expo SDK 54 工程；`1.0.4` 与 `1.0.5` 已切换到 compileSdk 37，不适用于当前配置。原有核对记录中的传递依赖包括 `androidx.annotation:annotation-jvm:1.9.1` 与 `androidx.dynamicanimation:dynamicanimation:1.1.0`，最终以实际构建解析结果为准。

### 其他原生许可原文

- [OkHttp 4.12.0](third-party/upstream/okhttp-4.12.0-LICENSE.txt)
- [jsoup 1.21.2](third-party/upstream/jsoup-1.21.2-LICENSE.txt)
- [AndroidSVG 1.4](third-party/upstream/androidsvg-1.4-LICENSE.txt)
- [React Native 0.81.5](third-party/upstream/react-native-0.81.5-LICENSE.txt)
- [Expo 54.0.33](third-party/upstream/expo-54.0.33-LICENSE.txt)与 [Expo 第三方声明](third-party/upstream/expo-54.0.33-THIRD-PARTY-LICENSES.txt)

### Google ML Kit

ML Kit SDK 及模型有独立使用条款，不应标为本项目的 MIT 或 Apache 开源组件。输入图像和 OCR 结果在设备上处理；SDK 可能连接 Google 获取更新，并发送性能及使用指标。参见 [ML Kit 官方条款与隐私说明](https://developers.google.com/ml-kit/terms)。

### 通话人声检测

通话使用 android-vad 的 WebRTC VAD 本地分类器，Android 封装和 WebRTC VAD 分别保留各自署名与许可原文；来源与范围见[原生人声检测依赖](third-party/native-speech-detection.md)。发布许可附件同时包含这两份原文。

## 外部服务与参考实现

模型 API、语音、腾讯翻译、MCP 服务和网易云公开接口属于外部服务，不因本项目源码公开而获得服务、品牌或内容授权。使用时仍需要各自的凭据、权限和条款。

`modules/netease-public-data` 的 EAPI 与公开只读接口参考了 `NeteaseCloudMusicApiEnhanced/api-enhanced`。维护时的审计记录已确认参考 commit，具体范围、上游署名与 MIT 原文见 [参考实现来源](third-party/reference-implementations.md)。本地使用 Kotlin 实现相应子集，未引入上游 Node/Express 服务；改写语言或只使用子集不取消已记录的来源说明。

项目六张原创图片、AI 生成的默认星空封面与两张 Expo 模板图片的来源和许可见 [asset-sources.md](asset-sources.md)。六张原创与两张模板图片于 2026-10-10 核对，星空封面来源于 2026-11-05 由维护者确认。

## 发布时如何保留声明

源码分发应保留本文件和实际涉及组件的版权、许可原文。安装包发布前，还应按实际 Android 构建变体核对 Gradle 传递依赖、原生第三方版权和字体许可，补齐本次清单标出的缺口，并让接收安装包的人能够取得对应声明。仅在 README 写一句“感谢开源项目”不能替代许可文件。
