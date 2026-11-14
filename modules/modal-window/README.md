# 独立弹窗窗口布局

`ModalWindow` 是 Android 13+ 的 RN 独立 Modal 内容容器。公共 `ModalSheet` 使用它，业务页面继续使用 `ModalSheet`，无需接触原生模块。

## 所有权

- RN `Modal` 拥有窗口显示、系统返回与销毁；`ModalSheet` 拥有主题、遮罩、入退场动画和打开完成回调。
- `ModalWindowView` 在接入时将**所属独立窗口**设为 `SOFT_INPUT_ADJUST_NOTHING`，关闭系统自动顶移；它不修改 Activity 的输入策略。
- 原生容器使用该窗口的 `WindowInsets.Type.ime()` 与窗口实际高度计算可用高度，通过 Expo Fabric 的原生尺寸状态更新 Yoga。计算不经过 JS 键盘事件，也不依赖 Activity 的坐标缓存。
- 窗口布局变化或输入法高度变化时重新计算；每次都从窗口高度扣除 IME，不能从已收缩的容器再次扣除。键盘隐藏时恢复完整窗口高度；导航栏安全区仍由现有公共组件处理，不和 IME 重复相加。
- 容器随独立窗口一起挂载与销毁；卸载移除窗口布局监听，迟到的 insets 不再提交尺寸。容器不单独留在仍存活的窗口中替换。
- 表单滚动、草稿、提交和操作按钮由现有 React Native 内容负责。长表单继续使用可收缩的滚动区，固定按钮放在滚动区外。

容器必须直接位于独立 Modal 的全屏根内容中，不能放进 Activity、偏移后的局部区域或另一层键盘避让容器。其高度由原生拥有，不传固定 `height`、`flex: 1` 或第二份键盘 padding。

## 验证与使用限制

模块通过 Expo 本地模块自动链接；新增原生能力需要更新开发客户端或安装包后才能运行，不提供旧客户端的 JS fallback。

`android/gradlew.bat :modal-window:testDebugUnitTest` 验证独立窗口输入模式、键盘反复开合及高度变化、窗口尺寸变化、其他 insets 保留和销毁后的迟到回调。JVM 测试在 JNI/Fabric 边界应用原生尺寸，不能替代真实设备上的渲染、输入法动画与 OEM 窗口行为验收。

`npm run verify:ui-input` 验证 React 表单草稿与主窗口避让，原生弹窗不再注册 JS 避让监听。设备验收应覆盖保存气泡组合、退出保存、预览文本、改写消息、表情编辑等共用窗口，检查键盘上方间隙、按钮可见性与再次打开后的布局。
