# 参考实现来源

本表记录未作为 npm 依赖引入、但在本地实现过程中参考过的外部项目。项目源码公开时保留对应上游署名与许可原文；参考协议不代表获得第三方服务或内容的授权。

## 网易云公开数据模块

- 本地实现：`modules/netease-public-data`。
- 参考项目：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)。
- 当时审阅的固定 commit：[f5ce55bcb46e29c8e5350ca796fb1cc9d9914acd](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tree/f5ce55bcb46e29c8e5350ca796fb1cc9d9914acd)，项目包版本为 `4.40.0`。
- 参考范围：当前 Kotlin 模块对应上游 EAPI 和公开只读接口子集，固定来源与被审阅文件如下。
- 上游署名：`Copyright (c) 2013-2022 Binaryify`。
- 许可：[MIT 原文快照](upstream/netease-api-enhanced-f5ce55bcb46e-LICENSE.txt)，原始地址记录于 [sources.json](upstream/sources.json)。

审阅范围包含 `util/crypto.js`、`util/request.js`、`util/option.js` 与歌曲搜索、歌单详情、歌曲详情、歌词和评论接口定义。当前模块使用 Kotlin/JCA 实现 MD5、AES-128-ECB envelope、HTTPS 请求与响应映射，未引入上游 Node/Express 服务，也未将上游完整请求层作为依赖打包。

这里保留已确定的参考来源与许可，不把改写或仅使用子集当作取消上游署名的理由，也不将整个模块宣称为没有参考实现的独立原创。网易云接口、音乐、歌词、评论与品牌的服务或内容权利不由上述 MIT 许可授予。

## 底部 Tab 栏动效（Floating Ball / Melting Ball）

- 本地实现：`src/features/chat/presentation/messages/components/bottomTabBar/`。
- 参考项目：
  - [moeen-mahmud/react-native-floating-tab](https://github.com/moeen-mahmud/react-native-floating-tab)（`main` 分支，参考时上游标记 Beta）。
  - [vipin14444/react-native-fluid-bottom-bar](https://github.com/vipin14444/react-native-fluid-bottom-bar)（`main` 分支）。
- 参考范围：普通主题凹槽的贝塞尔形态、小数选中序号驱动曲线与球体的弹簧运动模型。未引入上游 npm 包或 Skia，未复制 Dribbble 参考作品的设计素材。选中图标在移动球体内交叉淡入，导航与未读数沿用 RavenCat 原有契约。
- 上游署名：`Copyright (c) 2024 Moeen Mahmud`、`Copyright (c) 2026 Vipin Sharma`。
- 许可：[react-native-floating-tab MIT 原文快照](upstream/react-native-floating-tab-main-LICENSE.txt)、[react-native-fluid-bottom-bar MIT 原文快照](upstream/react-native-fluid-bottom-bar-main-LICENSE.txt)，原始地址记录于 [sources.json](upstream/sources.json)。

Glass 通过现有 `modules/liquid-glass` 原生材质绘制一个连续表面：圆角栏体与椭圆球体使用平滑并集距离场，实际位移的滞后量驱动拉伸、压低和融合宽度。模糊、折射、色散与边缘高光共用该轮廓，不再叠加圆球、SVG 连接片和独立底栏。`ravencat_liquidglass_effect.agsl` 基于 AndroidLiquidGlassView 1.0.3 shader 修改，保留文件内 QmDeve 的完整 MIT 许可与版权声明；上游许可另见 [原文快照](upstream/liquid-glass-1.0.3-LICENSE.txt)。

## 生图画布像素动效（img-fx Chromium Flow）

- 本地实现：`src/features/media/presentation/imageGenerationPixelShader.ts`、`imageGenerationPixelDocument.ts` 与 `ImageGenerationPixelEffect.tsx`。
- 参考项目：[Jakubantalik/img-fx](https://github.com/Jakubantalik/img-fx)，版本 `0.6.0`，固定 [commit 2098279964046e23bad86d9f42f41a3b06dca735](https://github.com/Jakubantalik/img-fx/tree/2098279964046e23bad86d9f42f41a3b06dca735)。
- 改编范围：`src/engine/shaders.ts` 中的噪声函数、Chromium Flow 分支、像素遮罩与双遍绘制方式，以及 `src/presets/pixels-organic.ts` 的基础参数。只保留这一种效果，浅色配色与对比度按移动画布调整；真实成图的溶解遮罩由本地实现。
- 上游署名：`Copyright (c) 2026 Jakub Antalik`。
- 许可：[MIT 原文快照](upstream/img-fx-0.6.0-LICENSE.txt)，固定来源同时记录于 [sources.json](upstream/sources.json)。完整许可也保存在 shader 字符串内，随 JS 包和本地渲染文档交付。

绘制复用已安装的 `react-native-webview`，使用本地 WebGL，不引入 Three.js、远程页面或上游演示图片、字体与付费预设。图片、提示词、凭据、业务请求与持久化均不进入动效文档；RN 继续展示真实图片、管理计时与请求终态，动效只在真实原图加载后溶解并释放。
