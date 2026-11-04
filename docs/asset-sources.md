# 图片与图标来源

2026-10-10 已按维护者说明与 Expo 官方模板逐项核对。维护者确认六张原创图片随项目采用根目录 [MIT 许可证](../LICENSE)，版权署名为枫渡；两张 Expo 模板图片保留上游许可和署名，不纳入维护者原创声明。

## 保留的资源

| 文件 | 当前用途 | 来源 | 许可 |
|---|---|---|---|
| `assets/icon.png` | 通用应用图标、启动图、预览版／发布版 Android 自适应图标前景和默认群头像 | 枫渡原创，替换了同名 Expo 图片 | 项目 MIT |
| `assets/adaptive-icon.png` | 开发版 Android 自适应图标前景 | 枫渡原创，替换了同名 Expo 图片 | 项目 MIT |
| `assets/fengdu.png` | 默认用户头像 | 枫渡原创 | 项目 MIT |
| `assets/raven.png` | 默认 AI 头像 | 枫渡原创 | 项目 MIT |
| `assets/yaya.png` | 内置鸦鸦悬浮皮肤，供原生模块生成资源 | 枫渡原创 | 项目 MIT |
| `assets/ravenphone_bg.png` | 默认时刻封面 | 枫渡原创 | 项目 MIT |
| `assets/stars.jpg` | AI 个人主页与朋友圈共用的默认星空封面 | 维护者使用文本 AI 模型生成 SVG 图像后形成的图片，2026-11-05 确认来源 | 随项目按 MIT 分发；单独记录 AI 生成来源 |
| `assets/favicon.png` | 保留的模板资源，Android 配置未引用 | Expo `expo-template-blank` | Expo MIT |
| `assets/splash-icon.png` | 保留的模板资源，当前启动图使用 `icon.png` | Expo `expo-template-blank` | Expo MIT |

文件名沿用 Expo 模板不代表图片本身仍来自 Expo。`icon.png` 和 `adaptive-icon.png` 的当前内容由维护者替换为原创图像。

两张保留的 Expo 图片与上游 commit `cfd65241fb73317b63e6736e7890a784a69940fc` 的 [favicon.png](https://github.com/expo/expo/blob/cfd65241fb73317b63e6736e7890a784a69940fc/templates/expo-template-blank/assets/favicon.png)、[splash-icon.png](https://github.com/expo/expo/blob/cfd65241fb73317b63e6736e7890a784a69940fc/templates/expo-template-blank/assets/splash-icon.png) 逐字节一致。对应 [Expo MIT 原文](third-party/upstream/expo-54.0.33-LICENSE.txt)已随仓库保留。

`modules/ravencat-floating-layer/android/src/main/res/drawable-nodpi/` 中的默认用户与 AI 头像分别是 `fengdu.png`、`raven.png` 的相同副本，沿用其项目 MIT。构建生成的鸦鸦皮肤资源来源于 `yaya.png`，不形成另一套素材来源。


## 已移出公开源码的资源

`crab.svg`、`crab2.svg`、`kimiball.svg`、`kimiball2.svg` 的版权来源未明确，且当前没有文件引用。它们已移入被 Git 忽略的 `tmp/open-source-preparation/assets/`，不随当前源码分发。旧悬浮皮肤 ID 的退役逻辑仍有恢复数据的用途，不因移出图片而删除。

**移出工作树里的公开路径不会清除 Git 历史中的图片。** 若首次公开不希望包含这些资源，应从审阅后的源码快照建立独立新仓库；若发布既有历史，需要另行决定历史处理方案，不能直接将当前仓库转为公开后才处理。

第三方字体与图标库见[第三方声明](third-party-notices.md)，不归为原创素材。

## 记忆星空天体影像

记忆星空新增七张 NASA 页面提供的天体与星云影像，随应用打包。这些素材不纳入项目原创图片的 MIT 声明；逐张来源、NASA／JPL／ESA 等署名、使用说明及运行时裁取与调色方式见[记忆星空图像说明](../src/features/memory/presentation/assets/README.md)。未使用 NASA 标志，也不表示 NASA 为本项目背书。

共享星空背景的来源与署名单独见[星空背景影像说明](../src/shared/ui/space/assets/README.md)。时间碎片日历新增十四张天体素材，逐张来源、署名及 AI 调色说明见[时间碎片影像](../src/features/companion/presentation/assets/fragments/README.md)；同样不纳入项目原创图片的 MIT 声明。
