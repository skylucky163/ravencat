/** 验证原生裁剪结果进入真实背景/封面保存入口，取消时不产生业务写入。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
function load(relative, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    fileName: relative,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `${relative} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

let screen = { width: 360, height: 800, scale: 3 };
let selection = { canceled: false, assets: [{ uri: 'file:///cropped.jpg', width: 1080, height: 2400 }] };
const picks = [];
const imagePicker = {
  requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
  launchImageLibraryAsync: async (options) => { picks.push(options); return selection; },
};
const cropping = load('src/platform/device/pickCroppedImage.ts', {
  'react-native': { Dimensions: { get: () => screen } },
  'expo-image-picker': imagePicker,
});
for (const aspect of [[1, 1], [16, 9], 'screen']) {
  assert.equal(await cropping.pickCroppedImage({ aspect }), selection.assets[0]);
  assert.deepEqual(picks.at(-1).aspect, aspect === 'screen' ? [1080, 2400] : aspect);
  assert.equal(picks.at(-1).allowsEditing, true);
}
screen = { width: 411.428571, height: 914.285714, scale: 2.625 };
await cropping.pickCroppedImage({ aspect: 'screen' });
assert.deepEqual(picks.at(-1).aspect, [1080, 2400], '屏幕比例转换为原生要求的整数，保留物理尺寸');
selection = { canceled: true, assets: null };
assert.equal(await cropping.pickCroppedImage({ aspect: [1, 1] }), null);
selection = { canceled: false, assets: [] };
await assert.rejects(cropping.pickCroppedImage({ aspect: 'screen' }), /未获取到有效图片/);

const react = {
  useState: (initial) => [initial, () => {}],
  useCallback: (callback) => callback,
  useEffect: () => {},
};
const native = {
  Alert: { alert() {} }, StyleSheet: { create: (styles) => styles, hairlineWidth: 1 },
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', TouchableOpacity: 'TouchableOpacity',
};
const jsx = (type, props) => ({ type, props });
const jsxRuntime = { jsx, jsxs: jsx, Fragment: 'Fragment' };
const { defaultLightTheme } = load('src/shared/theme/themes/defaultLight.ts');
const theme = { ...defaultLightTheme, effects: { ...defaultLightTheme.effects, glass: { enabled: true } } };
const writes = [];
const wallpaper = {
  appWallpaper: { mode: 'default' }, chatWallpaper: { mode: 'default' }, chatWallpaperOverrides: {},
  getChatWallpaper: () => ({ mode: 'default' }),
  setCustomAppWallpaper: async (uri) => writes.push({ kind: 'app', uri }),
  setCustomChatWallpaper: async (uri, keys) => writes.push({ kind: 'chat', uri, keys }),
  setCustomChatWallpaperOverride: async (key, uri) => writes.push({ kind: 'conversation', key, uri }),
};
const sharedTheme = {
  ...load('src/shared/theme/themeVariants.ts'),
  useTheme: () => theme, useThemedStyles: (create) => create(theme), useWallpaper: () => wallpaper,
  getThemeById: () => theme,
  isPaperNoteTheme: () => false,
  useThemeContext: () => ({ theme, themeId: theme.id, availableThemes: [], chatColorOverrides: {} }),
};
const uiDependencies = {
  react, 'react-native': native, 'react/jsx-runtime': jsxRuntime,
  'expo-image-picker': imagePicker, '@platform/device/DeviceMediaService': cropping, '@shared/theme': sharedTheme,
  '@shared/ui': { showAppDialog() {} },
};
function cards(node) {
  if (Array.isArray(node)) return node.flatMap(cards);
  if (!node || typeof node !== 'object') return [];
  return node.type === 'BackgroundPickerCard' ? [node.props] : cards(node.props.children);
}
const { default: ThemePickerView } = load('src/features/miniPrograms/presentation/ThemePickerView.tsx', {
  ...uiDependencies,
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  'lucide-react-native': { ChevronRight: 'ChevronRight', MessageCircle: 'MessageCircle' },
  '@shared/ui/NavigationHeader': { default: 'Header' },
  '@shared/ui/ColorPickerModal': { default: 'ColorPicker' },
  '@shared/ui/BackgroundPickerCard': { default: 'BackgroundPickerCard' },
  './GlassBlurSettings': { default: 'GlassBlurSettings' },
  './PaperNoteChatFooterSettings': { default: 'PaperNoteChatFooterSettings' },
  '@features/assistants': { listAIAssistants: async () => [{ id: 'ai' }] },
  '@features/chat': { useChatBubbleTextColors: () => ({
    userText: { color: theme.colors.chat.userText, defaultColor: theme.colors.chat.userText, label: '主题默认' },
    aiText: { color: theme.colors.chat.aiText, defaultColor: theme.colors.chat.aiText, label: '主题默认' },
  }), getCanonicalChatConversation: async () => ({ id: 'conversation' }), listGroupChats: async () => [{ id: 'group' }] },
});
function countBubbleSettings(node) {
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + countBubbleSettings(child), 0);
  if (!node || typeof node !== 'object') return 0;
  return node.type === 'Text' && node.props.children === '气泡编辑' ? 1 : countBubbleSettings(node.props.children);
}
const originalThemeId = theme.id;
for (const [themeId, expected] of [['default-light', 1], ['default-dark', 1], ['liquid-glass', 0], ['paper-note', 0], ['moon-kimi', 0]]) {
  theme.id = themeId;
  assert.equal(countBubbleSettings(ThemePickerView({ onBack() {} })), expected, `${themeId} 的气泡装饰设置可见性`);
}
theme.id = originalThemeId;
const { default: ChatWallpaperSettings } = load('src/features/chat/presentation/messages/components/ChatWallpaperSettings.tsx', {
  ...uiDependencies, '@shared/ui': { BackgroundPickerCard: 'BackgroundPickerCard' },
});
const { useMomentsCover: renderCover } = load('src/features/moments/presentation/useMomentsCover.ts', {
  ...uiDependencies,
  '../../../../assets/ravenphone_bg.png': 'default-cover',
  '@features/profile': {
    DEFAULT_USER_PROFILE: {},
    updateCurrentUserMomentsCover: async (uri, width) => { writes.push({ kind: 'cover', uri, width }); return {}; },
  },
});
const [appCard, chatCard] = cards(ThemePickerView({ onBack() {} }));
const [conversationCard] = cards(ChatWallpaperSettings({ chatKey: 'single:conversation' }));
for (const [action, expected] of [
  [appCard.onPick, { kind: 'app', uri: 'file:///cropped.jpg' }],
  [chatCard.onPick, { kind: 'chat', uri: 'file:///cropped.jpg', keys: ['single:conversation', 'group:group'] }],
  [conversationCard.onPick, { kind: 'conversation', key: 'single:conversation', uri: 'file:///cropped.jpg' }],
  [renderCover().pickCover, { kind: 'cover', uri: 'file:///cropped.jpg', width: 1080 }],
]) {
  selection = { canceled: false, assets: [{ uri: 'file:///cropped.jpg', width: 1080, height: 2400 }] };
  await action();
  assert.deepEqual(writes.at(-1), expected, '保存入口接收裁剪结果并保留原有绑定范围');
  assert.deepEqual(picks.at(-1).aspect, expected.kind === 'cover' ? [16, 9] : [1080, 2400]);
  const count = writes.length;
  selection = { canceled: true, assets: null };
  await action();
  assert.equal(writes.length, count, '取消选图或裁剪不覆盖旧背景/封面');
}

// 原生资源配置的稳定契约：实色顶栏、高对比度、重复生成不重复资源、不覆盖其他颜色。
const withImageCropColors = require('../plugins/withImageCropColors.js');
const { AndroidConfig } = require('expo/config-plugins');
const config = withImageCropColors({});
function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map((part) => parseInt(part, 16) / 255);
  return channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
for (const kind of ['colors', 'colorsNight']) {
  const mod = config.mods.android[kind];
  const first = await mod({ modResults: { resources: { color: [{ $: { name: 'unrelated' }, _: '#123456' }] } }, modRequest: {} });
  const second = await mod(first);
  assert.deepEqual(first.modResults, second.modResults);
  const palette = AndroidConfig.Colors.getColorsAsObject(second.modResults);
  assert.equal(palette.unrelated, '#123456');
  assert.equal(second.modResults.resources.color.length, 6);
  assert.match(palette.expoCropToolbarColor, /^#[0-9A-F]{6}$/i, '顶栏为实色');
  const background = luminance(palette.expoCropToolbarColor);
  for (const name of ['expoCropToolbarIconColor', 'expoCropToolbarActionTextColor', 'expoCropBackButtonIconColor']) {
    const foreground = luminance(palette[name]);
    assert.ok((Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05) >= 4.5, `${kind}.${name} 保持清晰对比度`);
  }
}
console.log('图片裁剪：比例、裁剪结果提交、取消保留原选择与原生顶栏对比度验证通过。');
