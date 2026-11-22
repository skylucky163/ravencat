/** 底栏设置回归：真实表单、弹窗生命周期与文件队列，原生输入、动画和文件使用可控替身。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', output)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `未声明依赖：${name}`);
    return dependencies[name];
  });
  return module.exports;
}

const lifetime = load('src/platform/device/MediaFileLifetime.ts');
const files = new Map();
const fileSystem = {
  documentDirectory: 'file:///app/',
  getInfoAsync: async (uri) => files.has(uri)
    ? { exists: true, isDirectory: files.get(uri) === 'directory', uri, size: 100 }
    : { exists: false },
  makeDirectoryAsync: async (uri) => { files.set(uri, 'directory'); },
  copyAsync: async ({ from, to }) => { files.set(to, files.get(from)); },
  deleteAsync: async (uri) => { files.delete(uri); },
};
const device = load('src/platform/device/PersistentImageStore.ts', {
  './MediaFileLifetime': lifetime, 'expo-file-system/legacy': fileSystem,
});
const theme = load('src/shared/theme/themes/paperNote.ts').paperNoteTheme;
const context = React.createContext(null);
let settings = { text: '原来的底栏文字', image: null };
const dialogs = [];
let pickerResult = { canceled: true };
const animations = new Set();
const native = {
  View: 'View', Text: 'Text', TextInput: 'TextInput', TouchableOpacity: 'TouchableOpacity',
  TouchableWithoutFeedback: 'Backdrop', Modal: 'Modal', ActivityIndicator: 'ActivityIndicator',
  Dimensions: { get: () => ({ height: 800 }) },
  StyleSheet: { create: (value) => value, hairlineWidth: 1, absoluteFill: {} },
  Animated: {
    Value: class { constructor(value) { this.value = value; } stopAnimation() {} }, View: 'AnimatedView',
    timing: (value, { toValue }) => ({ finish() { value.value = toValue; } }),
    parallel: (children) => {
      let callback;
      const animation = {
        start(handler) { callback = handler; animations.add(animation); },
        finish() {
          animations.delete(animation);
          children.forEach(child => child.finish());
          callback({ finished: true });
        },
        stop() { if (animations.delete(animation)) callback({ finished: false }); },
      };
      return animation;
    },
  },
};
const themeApi = {
  ThemedSurface: 'Surface', useTheme: () => theme, useThemedStyles: (factory) => factory(theme),
  useThemeContext: () => React.useContext(context),
};
const AppTextInput = load('src/shared/ui/AppTextInput.tsx', {
  react: React, 'react-native': native, '@shared/theme': themeApi,
}).default;
const ModalSheet = load('src/shared/ui/ModalSheet.tsx', {
  react: React, 'react-native': native, '@shared/theme': themeApi,
  'react-native-safe-area-context': { useSafeAreaInsets: () => ({ bottom: 0 }) },
  '../../../modules/modal-window': { ModalWindow: 'ModalWindow' },
}).default;
const Settings = load('src/features/miniPrograms/presentation/PaperNoteChatFooterSettings.tsx', {
  react: React,
  '../../../../assets/yaya.png': 1,
  'react-native': native,
  'expo-document-picker': { getDocumentAsync: async () => pickerResult },
  'expo-file-system/legacy': fileSystem,
  'lucide-react-native': { Pencil: 'Pencil', Upload: 'Upload' },
  '@platform/device': { ...device, ...lifetime },
  '@platform/device/DeviceMediaService': {
    copyPickedImageToAppStorage: (params) => device.persistentImageStore.copyPickedImageToAppStorage(params),
  },
  '@shared/theme': themeApi,
  '@shared/ui': {
    AppTextInput, Button: 'Button', MimeAwareImage: 'Image', ModalSheet,
    showAppDialog: (dialog) => dialogs.push(dialog),
  },
}).default;
function Harness() {
  const [value, setValue] = React.useState(settings);
  return React.createElement(context.Provider, { value: {
    chatFooter: value,
    setChatFooterImage: async (image) => {
      settings = { ...settings, image };
      setValue(settings);
    },
    setChatFooterText: async (text) => { settings = { ...settings, text }; setValue(settings); },
  } }, React.createElement(Settings));
}
let renderer;
const selections = [];
let focuses = 0;
const inputNative = {
  focus() {
    focuses++;
    const sheet = renderer.root.findAllByType('AnimatedView').find(node =>
      node.props.style.some(style => style?.transform));
    const transform = sheet.props.style.find(style => style?.transform).transform;
    assert.equal(transform[0].translateY.value, 0, '键盘焦点只在弹窗回到最终位置后请求');
  },
  setSelection(start, end) { selections.push({ start, end }); },
};
await act(async () => { renderer = create(React.createElement(Harness), {
  createNodeMock: element => element.type === 'TextInput' ? inputNative : null,
}); });
const button = (label) => renderer.root.findByProps({ accessibilityLabel: label });
async function press(label) {
  await act(async () => {
    button(label).props.onPress();
    // 文件替身立即完成；让本次 promise 链跑完，死锁时直接由 UI 状态断言失败。
    await new Promise(setImmediate);
  });
  assert.equal(button('上传底栏图标').props.disabled, false, '操作完成或取消后恢复上传入口');
  assert.equal(renderer.root.findAllByType('ActivityIndicator').length, 0, '操作完成后停止转圈');
}
const mediaRoot = 'file:///app/persistent-media/';
for (const [index, extension, mimeType] of [[1, 'png', 'image/png'], [2, 'svg', 'image/svg+xml'], [3, 'jpg', 'image/jpeg']]) {
  const previous = settings.image;
  const uri = `file:///picker/icon-${index}.${extension}`;
  files.set(uri, `图标${index}`);
  pickerResult = { canceled: false, assets: [{ uri, name: `icon.${extension}`, mimeType }] };
  await press('上传底栏图标');
  assert.equal(dialogs.length, 0, '正常替换不能报错');
  assert.equal(settings.image.mimeType, mimeType);
  assert.equal(files.get(`${mediaRoot}${settings.image.storageKey}`), `图标${index}`, '新引用指向已保存图标');
  if (previous) assert.equal(files.has(`${mediaRoot}${previous.storageKey}`), false, '替换完成后清理旧图标');
  const preview = renderer.root.findByType('Image');
  assert.equal(preview.props.uri, `${mediaRoot}${settings.image.storageKey}`, '同一页面立即预览新图标');
}
const savedImage = settings.image;
pickerResult = { canceled: true };
await press('上传底栏图标');
assert.equal(settings.image, savedImage, '取消选择保留原图标');
await press('恢复默认底栏图标');
assert.equal(settings.image, null);
assert.equal(files.has(`${mediaRoot}${savedImage.storageKey}`), false, '恢复默认后删除自定义图标');
assert.equal(renderer.root.findByType('Image').props.uri, null);
let queueAvailable = false;
await act(async () => {
  void lifetime.withMediaFileLifetime(async () => { queueAvailable = true; });
  await new Promise(setImmediate);
});
assert.equal(queueAvailable, true, '后续媒体操作仍能取得文件生命周期队列');

const finishAnimations = async () => { await act(async () => { [...animations].forEach(animation => animation.finish()); }); };
for (let cycle = 0; cycle < 2; cycle++) {
  const previousFocuses = focuses;
  const savedText = settings.text;
  await act(async () => button('编辑聊天底栏文字').props.onPress());
  assert.equal(focuses, previousFocuses, '原生窗口显示前不请求键盘');
  await act(async () => renderer.root.findByType('Modal').props.onShow());
  assert.equal(focuses, previousFocuses, '入场动画期间不请求键盘');
  const input = renderer.root.findByType('TextInput');
  await finishAnimations();
  assert.equal(focuses, previousFocuses + 1, '弹窗就绪后聚焦一次');
  assert.deepEqual(selections.at(-1), { start: 0, end: savedText.length }, '每次打开保留初始全选');
  assert.notEqual(input.props.selectTextOnFocus, true, '取消初始全选后由原生输入持有选区');
  const selectionCommands = selections.length;
  for (const text of [savedText + '!', savedText + '!字', savedText + '!字，']) {
    // 用户点击解除全选后输入：文字更新不能重新聚焦、全选或重播弹窗动画。
    await act(async () => input.props.onChangeText(text));
    assert.equal(renderer.root.findByType('TextInput'), input, '编辑时保留原生输入实例');
    assert.equal(input.props.value, text);
    assert.equal(selections.length, selectionCommands, '符号、中文和标点输入均不重设选区');
    assert.equal(focuses, previousFocuses + 1, '文字更新不重发键盘焦点请求');
    assert.equal(animations.size, 0, '输入不会重新移动弹窗');
  }
  await act(async () => renderer.root.findByProps({ title: '保存' }).props.onPress());
  await finishAnimations();
  assert.equal(renderer.root.findAllByType('TextInput').length, 0);
}
const beforeCancel = focuses;
await act(async () => button('编辑聊天底栏文字').props.onPress());
await act(async () => renderer.root.findByType('Modal').props.onShow());
await act(async () => renderer.root.findByType('Modal').props.onRequestClose());
await finishAnimations();
assert.equal(focuses, beforeCancel, '入场中关闭会取消待执行聚焦，不能在关闭后弹出键盘');
await act(async () => renderer.unmount());
console.log('聊天底栏设置：图标替换、文件队列、弹窗就绪聚焦、初始全选、连续输入与关闭取消验证通过。');
