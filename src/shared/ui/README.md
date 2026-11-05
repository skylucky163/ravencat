# UI 原子组件

纯展示组件，无业务逻辑，可在整个项目中复用。

玻璃主题的页面底层保持透明，主要卡片通过 `ThemedSurface` 使用原生材质。
长列表显式传入 `nativeGlass={false}`，输入框与卡片内部的小控件使用主题的轻量染色，
避免逐项模糊或白色底层堆叠。同一玻璃表面里的嵌套卡片不再重复开启原生效果。
`ModalSheet`、全局提示和问号说明气泡统一使用弹窗材质；普通主题保持自己的表面颜色。
`ModalSheet` 与主窗口表单共用统一的键盘边界容器，Feature 不重复监听键盘或添加避让留白。

## 组件列表

| 组件 | 用途 |
|-----|------|
| `AIAvatar` | AI 头像（首字母回退） |
| `AIInfoCard` | AI 信息展示卡片 |
| `AvatarImage` | 通用头像图片（带 fallback） |
| `AudioPlaybackBar` | 语音条：播放／暂停、进度、时长和互斥长短按；播放与文件解析由调用方注入，不包含聊天气泡 |
| `BackgroundPickerCard` | 背景类图片选择卡片（缩略预览 + 更换 / 恢复默认） |
| `Button` | 通用按钮（primary / secondary / danger / text） |
| `AppDialogHost` / `showAppDialog` | 全应用统一的报错、提示与确认弹窗 |
| `Card` | 通用卡片容器 |
| `CheckIcon` | 勾选图标 |
| `EmptyState` | 空状态占位 |
| `DropdownField` | 通用下拉字段（提供方、模型与参数选择） |
| `HeaderAddButton` | 导航头右上角新增入口：统一品牌色加号 |
| `InputField` | 通用输入框（带 label / hint） |
| `AppTextInput` | 不带字段外壳的输入基础控件，供聊天、通话等输入区复用 |
| `KeyboardAvoidingContainer` | 当前原生窗口内的统一键盘避让容器 |
| `ListItem` | 通用列表项 |
| `ModalSheet` | 底部弹窗 |
| `ModelPickerModal` | 模型、用途配置和服务共用的选择弹窗；支持忙碌、重读、列表底部取消选择和标题旁问号说明，统一不带管理跳转 |
| `NavigationHeader` | 通用页面导航头，可在标题后显示主题主色问号并打开锚定悬浮说明 |
| `Toggle` | 统一的二元开关，包含读屏状态及原生动画 |
| `ToggleField` | 带标题和说明的开关字段，支持页面注入布局、字体、编号和自定义内容，内部使用 `Toggle` |
| `ToggleDetailRow` | 卡片内的开关行：标题行带可选图标与开关，描述行显示灰色说明并进入详情 |
| `Slider` | 原生手势数值滑杆，支持范围、步长、实时变化及松手通知 |
| `SliderField` | 带标题、数值输入、范围和错误提示的滑杆字段 |
| `UserAvatar` | 用户头像 |

`HeaderAddButton` 默认自带导航头右侧的点击区内边距；与设置等其他头部按钮并排、由页面提供按钮容器时传 `variant="inline"`，并用 `style` 给出尺寸。

开关设置项统一使用 `ToggleField`：`layout="stacked"` 将说明放在行下方，`layout="inline"` 将说明放在开关左侧。页面通过 `rowStyle` 提供完整行布局时，组件直接使用该布局；未提供时保留默认表单容器。`contentStyle`、`labelStyle`、`hintStyle` 可替换各部分的默认样式，`style` 和 `toggleStyle` 分别补充外层与开关样式。编号或图标通过 `leading` 传入，状态标签和操作按钮等复杂内容可作为 `children` 保留原有结构。卡片材质与分组由页面负责，组件不保存业务状态；已有列表插槽中的独立开关仍使用 `Toggle`。

卡片内的「开关 + 说明跳转」行使用 `ToggleDetailRow`：标题与开关在第一行，灰色描述与箭头在第二行；`icon` 可选，不传时不保留图标列宽度；`divider` 由最后一项以外的列表成员开启。需要多行元信息时用 `detail` 替换描述区内容，箭头仍只由 `onOpenDetail` 决定。卡片材质与分组仍由页面负责，组件只接收当前值并回传变更。

页面只通过 `help.sections` 提供自己拥有的小标题和正文。导航头内部的 `NavigationHeaderHelp` 负责测量问号位置、打开带尖角的悬浮气泡，以及点击外部、系统返回和页面失焦时关闭；页面无需维护提示状态或监听根容器触摸。气泡以透明原生 `Modal` 显示，不占据页面布局，外部点击只关闭气泡，正文内部可滚动阅读。

主窗口和 Modal 的位置都经原生测量，再换算为浮层坐标，避免系统栏和多窗口偏移。气泡宽度受当前窗口限制，小尖角指向问号；页面离开或锚点重新布局后，迟到的测量不能重新打开气泡。问号两侧的布局占位对称，保持页面标题居中；不传 `help` 时不占用说明入口的空间。

## 输入与键盘边界

表单字段使用 `InputField`，自定义输入区使用 `AppTextInput`。两者共用原生输入基础：
普通字段默认单行；`autoGrow` 从单行高度自动换行并增长，达到 `maxHeight` 后在框内滚动。
增长由原生内容测量负责，不维护另一套 JS 高度状态。默认增长范围是 36–160，调用方可用
`minHeight` / `maxHeight` 调整；不要给 `autoGrow` 设置固定 `height`。`multiline` 仍可用于固定高度的正文编辑器。
`AppTextInput` 转发原生 ref、焦点、选择及提交事件，不保存业务草稿，不决定发送动作。
输入外观仍由主题和所在输入区提供，不要求聊天栏与表单长成同一种样式。

普通文本不根据 label、placeholder 或字段名推断密码模式。需要遮蔽的字段显式设置
`secureTextEntry`；这与窗口避让、自动换行是不同职责，不通过修改密码标志处理布局问题。

主窗口表单页及部分独立弹窗在当前窗口内容外包一层 `KeyboardAvoidingContainer`。容器用自身窗口原点与键盘顶边计算可用高度，
直接把底边限制在键盘顶部，不从原生窗口底边追加键盘 padding，因此原生窗口是否同时缩放不会造成二次避让。
隐藏键盘后恢复原始布局，迟到的测量不能恢复旧状态。原生 View 的 ref 接入/脱离定义测量有效期：脱离后忽略键盘事件，并立即失效尚未返回的测量，不依赖 React effect 稍后的清理顺序。
关闭但仍挂载的弹窗传 `enabled={visible}`，避免监听其他窗口的输入。

`ModalSheet` 也复用这个容器，并传 `fillsNativeWindow`：它已经铺满独立原生窗口，直接使用屏幕键盘顶边，
不再读取会被系统平移和 edge-to-edge 坐标问题污染的 `measureInWindow.y`。长表单由 Feature 在弹窗内提供可收缩的 `ScrollView`，
需要始终可见的操作按钮放在滚动区外；原生滚动容器负责把获得焦点的输入框滚入可见区域，不在调用点增加延时或另一套焦点测量。

需要打开即编辑的 `ModalSheet` 在 `onOpened` 中通过输入 ref 请求焦点。回调等待原生窗口
显示和入场动画完成；不要在仍被平移到屏幕外的输入上使用 `autoFocus`，也不要用 timer 猜测就绪时间。
初始全选也在这次回调中设置一次，后续选区由原生输入管理。

键盘避让的所有者是窗口布局，不是 `AppTextInput`；同一窗口不叠加原生缩放后的完整键盘
高度、手动留白和容器避让。聊天已有的键盘 / 表情 / 工具面板互斥仍由聊天输入区拥有；
通话输入窗口的关闭与聚焦仍由通话拥有。原生悬浮窗使用 Android 输入控件和自己的窗口布局，
不能套用 React 组件绕过它的所有权。

`npm run verify:ui-input` 验证受控草稿、原生 ref、敏感输入显式声明、键盘反复开合及监听释放；
真实换行尺寸和键盘动画仍需在 Android 设备上验收。

## 全局提示弹窗

`showAppDialog({ title, message, tone, buttons })` 用于报错、成功提示、权限说明和操作确认。
`AppDialogHost` 在宿主的主题和安全区域 Provider 内挂载一次，统一拥有展示队列；
调用方继续负责错误解释、业务执行和操作结果，不在公共 UI 中解析异常或重试。

视觉采用柔和圆角、简洁图标和纵向按钮，颜色跟随当前主题。长正文可滚动、选择复制，
按钮不随正文滚动。`tone` 可用 `info`、`success`、`warning`、`error`，默认 `info`。
不提供 `buttons` 时显示“知道了”；操作按钮的 `style` 可用 `default`、`cancel`、`destructive`。
危险操作保持显式确认，返回键或点击遮罩只关闭提示并调用 `onDismiss`，不会执行按钮回调。
必须让用户选择按钮时可传 `dismissible: false`。

连续提示按到达顺序展示；选择按钮后先移出当前提示再调用业务回调，回调产生的新提示继续进入队列。
重复点击不重复执行操作。宿主卸载时清空展示队列，不触发业务回调，不保留旧页面闭包。
这套提示只用于应用内 UI，不承担 Android 通知或 Headless execution 的交付。

```tsx
showAppDialog({
  title: '保存失败',
  message: '无法保存当前配置，请检查后再试。',
  tone: 'error',
});
```

`npm run verify:ui-dialog` 验证确认、关闭、连续提示和宿主卸载行为。

## 添加新组件

`Toggle` 和 `ToggleField` 是受控组件：页面持有业务值、确认弹窗和保存流程，开关只通过
`onValueChange` 表达切换意图，在 `value` 更新后播放动画。异步保存或等待确认时不会先自行
翻转再被旧值拉回。轨道淡入及滑块位移使用原生动画，触摸区域为 48 × 44。
开启轨道使用主题主色；关闭轨道、边框和滑块使用 `components.toggle` 的不透明颜色，
玻璃主题也保持可见。页面不单独设置开关颜色。
`npm run verify:ui-toggle` 验证异步保存、取消确认、禁用、外部状态更新及五个主题的可见性。

`Slider` 为受控组件，调用方保证 `min < max`、`step > 0` 且 `value` 为范围内的合法数值，
可用 `upperLimit` 在固定刻度中约束实际终点，调用方保证 `min <= value <= upperLimit <= max`；调整约束不会改变刻度比例。
通过 `onValueChange` 更新当前值，`onSlidingComplete` 决定提交时机。横向拖动明确激活后才改值，纵向滑动让位父滚动；轻点轨道仍可跳转。
快速松手采样最终坐标，系统中断保留最后有效值；禁用时不接受调整。
`SliderField` 在拖动期间只展示本地预览，松手通过 `onSetValue` 通知表单；手动输入及错误原样交给表单，
不解析、保存或回填业务草稿。使用这两个组件的页面需位于已有的 `GestureHandlerRootView` 内。
`npm run verify:ui-slider` 验证手势中断、快速松手、小数步长和已有页面的接入行为；`node --no-warnings scripts/verify-slider-gestures.mjs` 验证纵向让位、激活与取消的手势契约。

1. 创建 `.tsx` 文件
2. 默认导出组件
3. 在此目录 `index.ts` 中添加导出
4. 更新本 README
## 分享窗口

`ShareSheet` 提供选择对象、内容预览、附言和确认发送的公共交互。调用者传入目标展示数据与预览节点，持有内容、加载、错误和发送状态，并负责真实提交。指定固定目标时关闭目标切换。窗口统一处理键盘避让，不读取 Feature 目录或持有业务导航。
