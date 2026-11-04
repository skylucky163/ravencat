/** 页面会话真实行为：草稿隔离、退出确认、保存失败保留、异步图片生命周期。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: file,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (id === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, id), `未声明依赖 ${id}`); return dependencies[id];
  }, module, module.exports);
  return module.exports;
}
const domain = load('src/features/chat/appearance/domain/ChatBubbleSkin.ts');
const draftApi = load('src/features/chat/appearance/application/BubbleSkinDraft.ts');
const original = { id: 'saved', revision: 1, name: '海蓝', role: 'user', textColor: '#FFFFFF',
  image: { mediaAssetId: 'base', uri: 'file:///persistent/base.png', width: 120, height: 90 },
  config: domain.defaultBubbleSkinConfig(120, 90), decorations: [] };
const saves = [];
let rejectSave = false;
let serial = 0;
let disposed = 0;
let prepareImage = async () => ({ uri: 'file:///cache/draft.png', width: 120, height: 90, dispose: async () => { disposed++; } });
const imageKinds = [];
let skinState = { presets: [original, { ...original, id: 'saved-ai', role: 'ai', textColor: '#1C1C1E' },
  { ...original, id: 'other', textColor: '#ABCDEF' }], user: original, ai: null };
skinState.ai = skinState.presets[1];
const skinListeners = new Set();
const publishSkins = next => { skinState = next; skinListeners.forEach(listener => listener()); };
const setPresetColor = async (id, color) => {
  const presets = skinState.presets.map(item => item.id === id ? { ...item, textColor: color } : item);
  publishSkins({ ...skinState, presets, user: presets.find(item => item.id === skinState.user?.id) ?? null,
    ai: presets.find(item => item.id === skinState.ai?.id) ?? null });
};
const skinHook = load('src/features/chat/appearance/presentation/useChatBubbleSkins.ts', {
  react: React, '../application/ChatBubbleSkinRuntime': {
    getBubbleSkinSnapshot: () => skinState, loadChatBubbleSkins: async () => {},
    subscribeBubbleSkins: listener => { skinListeners.add(listener); return () => skinListeners.delete(listener); },
  },
});
const { useBubbleSkinEditor } = load('src/features/chat/appearance/presentation/useBubbleSkinEditor.ts', {
  react: React, '@platform/device': { createRandomUUID: () => `new-${++serial}` },
  '@platform/device/MessageBubbleBackground': { prepareBubbleDraftImage: (uri, kind) => { imageKinds.push(kind); return prepareImage(uri); } },
  '../application/BubbleSkinDraft': draftApi, '../domain/ChatBubbleSkin': domain,
  './useChatBubbleSkins': skinHook,
  '../application/ChatBubbleSkinRuntime': {
    loadChatBubbleSkins: async () => {}, openBubbleSkinDraft: async (role, id) => id === null
      ? { ...original, id: 'new-draft', role, revision: 0, textColor: domain.DEFAULT_BUBBLE_TEXT_COLORS[role] }
      : { ...skinState.presets.find(item => item.id === id), role },
    setChatBubblePresetTextColor: setPresetColor,
    saveBubbleSkinDraft: async value => { if (rejectSave) throw new Error('磁盘写入失败'); saves.push(value); },
  },
  './pickBubbleImage': { withPickedBubbleImage: task => task('file:///picker.png') },
});
let editor;
function Harness() { editor = useBubbleSkinEditor('user', 'saved'); return null; }
let renderer;
await act(async () => { renderer = create(React.createElement(Harness)); });
assert.equal(editor.dirty, false);
assert.equal(await editor.requestLeave(), true);
act(() => editor.update({ ...editor.draft, config: { ...editor.draft.config,
  padding: { ...editor.draft.config.padding, left: 40 } } }));
assert.equal(editor.dirty, true);
assert.notEqual(original.config.padding.left, 40, '拖动只修改草稿，不修改已启用作品');
const confirm = async choice => {
  let result;
  act(() => { result = editor.requestLeave(); });
  assert.equal(editor.savePrompt, 'leave');
  await act(async () => { if (choice === '继续编辑') editor.cancelSave(); else editor.discardChanges(); });
  return result;
};
assert.equal(await confirm('继续编辑'), false);
assert.equal(await confirm('放弃修改'), true);
assert.equal(saves.length, 0);
rejectSave = true;
let leaving;
let leaveResolved = false;
act(() => { leaving = editor.requestLeave(); void leaving.then(() => { leaveResolved = true; }); });
act(() => editor.setSaveName(' 海蓝新款 '));
await act(async () => editor.confirmSave());
assert.equal(editor.error, '磁盘写入失败');
assert.equal(editor.dirty, true, '保存失败继续拦截退出，草稿可继续修正');
assert.equal(editor.savePrompt, 'leave');
assert.equal(editor.saveName, ' 海蓝新款 ');
assert.equal(leaveResolved, false, '保存失败保留同一个命名窗口，不能提前完成退出');
rejectSave = false;
await act(async () => editor.confirmSave());
assert.equal(await leaving, true);
assert.equal(editor.dirty, false);
assert.equal(saves[0].config.padding.left, 40);
assert.equal(saves[0].name, '海蓝新款');
await act(async () => editor.importImage(2));
assert.equal(imageKinds.at(-1), 'decoration');
assert.equal(editor.draft.decorations[0].slot, 2);
assert.equal(editor.draft.decorations[0].mediaAssetId, null);
assert.equal(original.decorations.length, 0);
assert.equal(saves.length, 1, '上传新饰品也不提前持久化或生效');
const updateDraft = editor.update;
act(() => updateDraft(before => ({ ...before, config: { ...before.config, padding: { ...before.config.padding, right: 35 } } })));
act(() => updateDraft(before => ({ ...before, config: { ...before.config, padding: { ...before.config.padding, top: 22 } } })));
assert.equal(editor.draft.config.padding.left, 40);
assert.equal(editor.draft.config.padding.right, 35, '连续手势回调以最新草稿为准，不覆盖另一侧已经调整的值');
assert.equal(editor.draft.decorations[0].slot, 2);
assert.equal(editor.dirty, true);
act(() => renderer.unmount());
assert.equal(disposed, 1, '退出释放页面持有的缓存图，不释放收藏中的媒体');

let completeImage;
prepareImage = () => new Promise(resolve => { completeImage = resolve; });
await act(async () => { renderer = create(React.createElement(Harness)); });
let importing;
act(() => { importing = editor.importImage(null); });
assert.equal(imageKinds.at(-1), 'background', '底图与装饰在图片导入边界使用各自的预算');
assert.equal(await editor.requestLeave(), false, '准备图片期间不允许把页面会话提前移除');
act(() => renderer.unmount());
await act(async () => {
  completeImage({ uri: 'file:///late.png', width: 120, height: 90, dispose: async () => { disposed++; } });
  await importing;
});
assert.equal(disposed, 2, '页面销毁后才返回的原生图片也正确清理');
assert.equal(saves.length, 1);

// 路由层承接系统/原生 Stack 的返回动作，业务页只报告是否允许离开。
let navigationGuard;
let prevented;
let allowed = false;
const dispatched = [];
const route = load('src/app/bubble-skin.tsx', {
  react: React, 'expo-router': {
    useLocalSearchParams: () => ({ role: 'ai', presetId: 'preset-a' }), useRouter: () => ({ back: () => {} }),
    useNavigation: () => ({ dispatch: action => dispatched.push(action) }), Redirect: 'Redirect',
  },
  '@react-navigation/native': { usePreventRemove: (flag, callback) => { prevented = flag; navigationGuard = callback; } },
  '@features/chat': { ChatBubbleSkinEditorScreen: 'EditorScreen' },
}).default;
act(() => { renderer = create(React.createElement(route)); });
act(() => renderer.root.findByType('EditorScreen').props.onNavigationStateChange({ dirty: true, requestLeave: async () => allowed }));
assert.equal(prevented, true);
const action = { type: 'GO_BACK', source: 'gesture' };
await act(async () => navigationGuard({ data: { action } }));
assert.deepEqual(dispatched, [], '取消退出不能先 pop 页面');
allowed = true;
await act(async () => navigationGuard({ data: { action } }));
assert.deepEqual(dispatched, [action], '确认后继续原始返回动作');
act(() => renderer.unmount());
console.log('气泡编辑会话：保存/放弃/取消、失败保留、图片所有权与 Stack 返回保护验证通过。');

// 页面操作始终修改同一份预览；留白工具、文字色、四槽饰品和右上角保存可完整走通。
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const darkTheme = load('src/shared/theme/themes/defaultDark.ts').defaultDarkTheme;
const themeRegistry = {
  DEFAULT_THEME_ID: theme.id, AVAILABLE_THEMES: [theme, darkTheme],
  getThemeById: id => [theme, darkTheme].find(item => item.id === id),
  getThemeSelectionDisabledReason: () => undefined,
};
const storedThemeColors = new Map();
let storedThemeId = theme.id;
const { ThemeProvider, ThemeContext } = load('src/shared/theme/ThemeProvider.tsx', {
  react: React, './themeRegistry': themeRegistry,
  './themeStorage': {
    loadStoredThemeId: async () => storedThemeId, loadGlassBlurRadius: async () => undefined,
    loadChatColorOverrides: async id => storedThemeColors.get(id) ?? {},
    saveChatColorOverrides: async (id, colors) => { storedThemeColors.set(id, colors); },
    saveThemeId: async id => { storedThemeId = id; }, saveGlassBlurRadius: async () => {},
  },
  './chatFooterSettings': { DEFAULT_CHAT_FOOTER_SETTINGS: { text: null, image: null },
    loadChatFooterSettings: async () => ({ text: null, image: null }), saveChatFooterSettings: async () => {} },
});
let themeState;
function ThemeObserver() { themeState = React.useContext(ThemeContext); return null; }
const native = { View: 'View', Text: 'Text', Image: 'Image', Pressable: 'Pressable', ScrollView: 'ScrollView',
  TouchableOpacity: 'TouchableOpacity', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: value => value, hairlineWidth: 1 } };
const themed = {
  useTheme: () => React.useContext(ThemeContext)?.theme ?? theme,
  useThemeContext: () => React.useContext(ThemeContext),
  useThemedStyles: factory => factory(React.useContext(ThemeContext)?.theme ?? theme),
  getThemeById: themeRegistry.getThemeById,
};
const base = { react: React, 'react-native': native, '@shared/theme': themed };
const styles = load('src/features/chat/appearance/presentation/BubbleSkinEditor.styles.ts', { 'react-native': native });
const defaultExport = value => ({ __esModule: true, default: value });
const controls = load('src/features/chat/appearance/presentation/BubbleDecorationControls.tsx', {
  ...base, '@shared/ui': { Button: 'Button' }, '@shared/ui/Slider': defaultExport('Slider'),
  'lucide-react-native': { Plus: 'Plus' },
  '../domain/ChatBubbleSkin': domain, './BubbleSkinEditor.styles': styles,
});
const saveSheet = load('src/features/chat/appearance/presentation/BubbleSkinSaveSheet.tsx', {
  ...base, '@shared/ui': { Button: 'Button', InputField: 'InputField', ModalSheet: 'Sheet' }, './BubbleSkinEditor.styles': styles,
});
const Screen = load('src/features/chat/appearance/presentation/ChatBubbleSkinEditorScreen.tsx', {
  ...base, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  '@shared/ui': { Button: 'Button', InputField: 'InputField', KeyboardAvoidingContainer: 'Keyboard', ModalSheet: 'Sheet' },
  '@shared/ui/NavigationHeader': defaultExport(props => React.createElement('Header', props, props.rightButton)),
  '@shared/ui/ColorPickerModal': defaultExport('ColorPicker'), '@shared/ui/Slider': defaultExport('Slider'),
  '../domain/ChatBubbleSkin': domain, './BubbleFrameGuides': { BubbleFrameGuides: 'Guides' },
  './BubbleDecorationControls': controls, './BubbleSkinPreview': { BubbleSkinPreview: 'Preview' },
  './BubbleSkinSaveSheet': saveSheet,
  './useBubbleSkinEditor': { useBubbleSkinEditor: (...args) => { editor = useBubbleSkinEditor(...args); return editor; } },
  './BubbleSkinEditor.styles': styles,
}).ChatBubbleSkinEditorScreen;
prepareImage = async () => ({ uri: 'file:///cache/editor.png', width: 120, height: 90, dispose: async () => { disposed++; } });
let backCount = 0;
let navigationState;
await act(async () => { renderer = create(React.createElement(ThemeProvider, null,
  React.createElement(ThemeObserver), React.createElement(Screen, { role: 'user', presetId: 'saved',
    onBack: () => { backCount++; }, onNavigationStateChange: value => { navigationState = value; } }))); });
const preview = () => renderer.root.findByType('Preview');
const button = title => renderer.root.findAllByType('Button').find(node => node.props.title === title);
const tab = title => renderer.root.findAllByType('Pressable').find(node => node.props.accessibilityRole === 'tab' && node.findByType('Text').props.children === title);
const sheet = title => renderer.root.findAllByType('Sheet').find(node => node.props.title === title);
const saveWindow = () => sheet('保存气泡组合');
act(() => button('编辑预览文本').props.onPress());
assert.equal(sheet('编辑预览文本').props.visible, true);
for (const sample of ['好', ' ', '', '  \n  ', '很长的预览文本。'.repeat(180)]) {
  act(() => sheet('编辑预览文本').findByType('InputField').props.onChangeText(sample));
  assert.equal(preview().props.text, sample, '预览原样保留空白或长文本，不替换为默认句子');
  assert.equal(navigationState.dirty, false, '预览文字不属于组合草稿，不触发退出保存');
}
act(() => sheet('编辑预览文本').findByType('Button').props.onPress());
assert.equal(sheet('编辑预览文本').props.visible, false);
assert.equal(button('文字避开边框'), undefined);
const previewInstance = preview();
const slider = label => renderer.root.findAllByType('Slider').find(node => node.props.accessibilityLabel === label);
const rightBefore = { value: slider('右固定边框').props.value, max: slider('右固定边框').props.max };
act(() => renderer.root.findAllByType('Slider').find(node => node.props.accessibilityLabel === '上固定边框').props.onValueChange(40));
assert.equal(preview().props.appearance.skin.config.slices.top, 40);
act(() => slider('左固定边框').props.onValueChange(50));
assert.equal(slider('右固定边框').props.value, rightBefore.value);
assert.equal(slider('右固定边框').props.max, rightBefore.max, '左侧调整不改变右侧刻度或进度位置');
assert.equal(preview().props.appearance.skin.config.scale, original.config.scale, '修改切线不会改变底图固定显示比例');
act(() => tab('文字留白').props.onPress());
assert.equal(preview(), previewInstance, '切换操作不重建或切走上方聊天预览');
const beforePadding = { ...preview().props.appearance.skin.config.padding };
act(() => slider('左文字留白').props.onValueChange(36));
assert.equal(slider('右文字留白').props.value, beforePadding.right);
assert.equal(slider('右文字留白').props.max, 256);
act(() => slider('上文字留白').props.onValueChange(18));
assert.equal(slider('下文字留白').props.value, beforePadding.bottom);
assert.equal(slider('左文字留白').props.value, 36);
act(() => button('文字避开边框').props.onPress());
assert.equal(preview().props.appearance.skin.config.padding.top, 20);
assert.equal(button('文字避开边框').props.disabled, true, '留白已满足边框时禁止无效点击');
const draftBeforeColor = draftApi.bubbleDraftFingerprint(editor.draft);
await act(async () => renderer.root.findByType('ColorPicker').props.onConfirm('#223344'));
assert.equal(skinState.user.textColor, '#223344');
assert.equal(renderer.root.findByType('ColorPicker').props.currentColor, '#223344');
assert.equal(draftApi.bubbleDraftFingerprint(editor.draft), draftBeforeColor, '已保存组合的字色即时提交，不进入结构草稿');
act(() => tab('装饰').props.onPress());
assert.equal(renderer.root.findAllByType('Pressable').filter(node => node.props.accessibilityLabel?.startsWith('上传到饰品槽')).length, 4);
await act(async () => editor.importImage(2));
assert.equal(preview().props.appearance.skin.decorations[0].slot, 2);
act(() => slider('装饰最大尺寸').props.onValueChange(88));
assert.equal(preview().props.appearance.skin.decorations[0].config.size, 88);
assert.equal(navigationState.dirty, true);
function scrollOwner(node) {
  while (node !== null && node.type !== 'ScrollView') node = node.parent;
  return node;
}
assert.notEqual(scrollOwner(preview()), null);
assert.equal(scrollOwner(preview()), scrollOwner(slider('装饰最大尺寸')), '预览和参数由同一整页滚动容器持有');
act(() => button('保存').props.onPress());
assert.equal(backCount, 0, '先命名，确认保存成功后才返回');
assert.equal(saveWindow().props.visible, true);
act(() => saveWindow().findByType('InputField').props.onChangeText('正式作品'));
await act(async () => saveWindow().findAllByType('Button').find(node => node.props.title === '保存').props.onPress());
assert.equal(backCount, 1);
assert.equal(saves.at(-1).name, '正式作品');
assert.equal(Object.hasOwn(saves.at(-1).config, 'textColor'), false);
assert.equal(saves.at(-1).decorations[0].config.size, 88);
assert.equal(navigationState.dirty, false);
assert.equal(saveWindow().props.visible, false);
assert.equal(saveWindow().findAllByType('Button').every(node => node.props.disabled), true,
  '退出动画期间不能再次触发保存或放弃');
act(() => saveWindow().props.onClose());
act(() => renderer.unmount());
console.log('气泡编辑页面：同一预览、三个操作页签、文字色、四槽饰品与右上角保存验证通过。');

// 两个真实入口共用组合字色；主题只负责默认气泡。
const variants = load('src/shared/theme/themeVariants.ts');
const colorsHook = load('src/features/chat/appearance/presentation/useChatBubbleTextColors.ts', {
  '@shared/theme': { ...themed, ...variants },
  '../application/ChatBubbleSkinRuntime': { setChatBubblePresetTextColor: setPresetColor },
  '../domain/ChatBubbleSkin': domain, './useChatBubbleSkins': skinHook,
});
const Appearance = load('src/features/miniPrograms/presentation/ThemePickerView.tsx', {
  ...base, '@shared/ui': { showAppDialog: () => {} },
  'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  'expo-image-picker': {}, '@platform/device/DeviceMediaService': {},
  '@expo/vector-icons': { Ionicons: 'Ionicons' }, 'lucide-react-native': { ChevronRight: 'ChevronRight', MessageCircle: 'MessageCircle' },
  '@shared/theme': { ...themed, ...variants, useWallpaper: () => ({ appWallpaper: { mode: 'default' }, chatWallpaper: { mode: 'default' } }) },
  '@shared/ui/NavigationHeader': defaultExport('Header'), '@shared/ui/ColorPickerModal': defaultExport('ColorPicker'),
  '@shared/ui/BackgroundPickerCard': defaultExport('BackgroundPicker'), './GlassBlurSettings': defaultExport('GlassSettings'),
  './PaperNoteChatFooterSettings': defaultExport('PaperFooter'), '@features/assistants': {}, '@features/chat': colorsHook,
}).default;
const colorPair = (role = 'user', presetId = role === 'user' ? 'saved' : 'saved-ai') => React.createElement(ThemeProvider, null,
  React.createElement(ThemeObserver), React.createElement(Appearance, { onBack: () => {}, onOpenBubbleSkins: () => {} }),
  React.createElement(Screen, { key: `${role}:${presetId}`, role, presetId, onBack: () => {}, onNavigationStateChange: () => {} }));
storedThemeColors.clear();
await act(async () => { renderer = create(colorPair()); });
const editorColor = () => renderer.root.findByType(Screen).findByType('ColorPicker');
const appearanceColor = () => renderer.root.findByType(Appearance).findByType('ColorPicker');
const openAppearanceColor = label => {
  act(() => renderer.root.findByType(Appearance).findAllByType('TouchableOpacity')
    .find(node => node.findAllByType('Text').some(text => text.props.children === label)).props.onPress());
};
openAppearanceColor('用户文字');
await act(async () => editorColor().props.onConfirm('#345678'));
assert.equal(appearanceColor().props.currentColor, '#345678', '编辑气泡改色同步外观页色块');
assert.equal(skinState.ai.textColor, '#1C1C1E', '我的改色不影响 AI');
assert.equal(editor.dirty, false, '已保存组合改色不触发结构草稿保存');
await act(async () => appearanceColor().props.onConfirm('#456789'));
assert.equal(editorColor().props.currentColor, '#456789', '外观页改色同步编辑气泡');
assert.equal(storedThemeColors.size, 0, '组合字色不复制到主题存储');
await act(async () => appearanceColor().props.onReset());
assert.equal(editorColor().props.currentColor, domain.DEFAULT_BUBBLE_TEXT_COLORS.user);
await act(async () => editorColor().props.onConfirm('#456789'));
assert.equal(await editor.requestLeave(), true);
await act(async () => themeState.setThemeId(darkTheme.id));
assert.equal(editorColor().props.currentColor, '#456789', '深浅主题共用组合的一份字色');
await act(async () => {
  publishSkins({ ...skinState, user: skinState.presets.find(item => item.id === 'other') });
  renderer.update(colorPair('user', 'other'));
});
assert.equal(appearanceColor().props.currentColor, '#ABCDEF', '切换组合使用它自己的字色');
await act(async () => appearanceColor().props.onConfirm('#998877'));
assert.equal(editorColor().props.currentColor, '#998877');
assert.equal(skinState.presets.find(item => item.id === 'saved').textColor, '#456789', '外观页只修改当前启用组合');
await act(async () => {
  publishSkins({ ...skinState, user: skinState.presets.find(item => item.id === 'saved') });
  renderer.update(colorPair());
});
assert.equal(editorColor().props.currentColor, '#456789', '切回组合保留原色');
await act(async () => renderer.update(colorPair('user', null)));
await act(async () => editorColor().props.onConfirm('#8899AA'));
assert.equal(editor.dirty, true, '新组合的初始字色随首次保存');
assert.equal(skinState.user.textColor, '#456789', '新组合草稿不修改已启用组合');
await act(async () => renderer.update(colorPair('ai')));
openAppearanceColor('AI 文字');
await act(async () => editorColor().props.onConfirm('#567890'));
assert.equal(appearanceColor().props.currentColor, '#567890');
await act(async () => editorColor().props.onReset());
assert.equal(appearanceColor().props.currentColor, domain.DEFAULT_BUBBLE_TEXT_COLORS.ai);
await act(async () => {
  publishSkins({ ...skinState, user: null });
  themeState.setThemeId(theme.id);
});
openAppearanceColor('用户文字');
await act(async () => appearanceColor().props.onConfirm('#123456'));
assert.equal(themeState.theme.colors.chat.userText, '#123456', '默认气泡继续修改主题自己的字色');
assert.equal(skinState.presets.find(item => item.id === 'saved').textColor, '#456789');
act(() => renderer.unmount());
await act(async () => { renderer = create(colorPair()); });
assert.equal(editorColor().props.currentColor, '#456789', '未启用组合的编辑页也读取该组合自己的字色');
act(() => renderer.unmount());
console.log('气泡与外观字色：同一来源、组合/角色隔离、跨主题共用、默认气泡与新建草稿验证通过。');

// 组合管理按归属展开；名称选择与编辑、删除是独立操作。
let selected = { user: null, ai: null };
const presets = [{ id: 'mine', role: 'user', name: '我的收藏' }, { id: 'theirs', role: 'ai', name: 'AI 收藏' }];
const selectionCalls = [];
const editCalls = [];
const removalCalls = [];
const managementDialogs = [];
const managementStyles = load('src/features/chat/appearance/presentation/ChatBubbleSkinSettings.styles.ts', { 'react-native': native });
const Management = load('src/features/chat/appearance/presentation/ChatBubbleSkinSettings.tsx', {
  ...base, 'react-native-safe-area-context': { SafeAreaView: 'SafeArea' },
  'lucide-react-native': Object.fromEntries(['ChevronRight', 'Pencil', 'Plus', 'Trash2'].map(name => [name, name])),
  '@shared/ui': { showAppDialog: options => managementDialogs.push(options) },
  '@shared/ui/NavigationHeader': defaultExport('Header'),
  '../application/ChatBubbleSkinRuntime': {
    selectChatBubblePreset: async (role, id) => { selected = { ...selected, [role]: id }; selectionCalls.push([role, id]); },
    removeChatBubblePreset: async id => { removalCalls.push(id); },
  },
  './useChatBubbleSkins': { useChatBubbleSkins: () => ({ presets, error: null,
    user: presets.find(item => item.id === selected.user) ?? null, ai: presets.find(item => item.id === selected.ai) ?? null }) },
  './ChatBubbleSkinSettings.styles': managementStyles,
}).ChatBubbleSkinSettings;
const managementProps = { onBack: () => {}, onEdit: (...args) => editCalls.push(args) };
act(() => { renderer = create(React.createElement(Management, managementProps)); });
const press = async label => { await act(async () => renderer.root.findByProps({ accessibilityLabel: label }).props.onPress()); };
assert.equal(renderer.root.findByProps({ accessibilityLabel: '我的气泡组合' }).props.accessibilityState.expanded, true);
assert.equal(renderer.root.findByProps({ accessibilityLabel: 'AI 的气泡组合' }).props.accessibilityState.expanded, true);
assert.equal(renderer.root.findAllByProps({ accessibilityLabel: '使用我的收藏' }).length, 1);
assert.equal(renderer.root.findAllByProps({ accessibilityLabel: '使用AI 收藏' }).length, 1, '两侧默认展开各自组合');
const textColor = label => Object.assign({}, ...[renderer.root.findByProps({ accessibilityLabel: label }).findByType('Text').props.style].flat(Infinity).filter(Boolean)).color;
assert.equal(textColor('我的默认气泡'), theme.colors.brand.primary);
assert.equal(textColor('AI 的默认气泡'), theme.colors.brand.primary);
await press('我的气泡组合');
assert.equal(renderer.root.findAllByProps({ accessibilityLabel: '使用我的收藏' }).length, 0);
assert.equal(renderer.root.findAllByProps({ accessibilityLabel: '使用AI 收藏' }).length, 1, '单侧收起不改变另一侧展开状态');
await press('我的气泡组合');
await press('编辑我的收藏');
assert.deepEqual(editCalls, [['user', 'mine']]);
assert.deepEqual(selectionCalls, [], '编辑按钮不启用作品');
await press('使用我的收藏');
act(() => { renderer.update(React.createElement(Management, managementProps)); });
assert.deepEqual(selectionCalls, [['user', 'mine']]);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '使用我的收藏' }).props.accessibilityState.selected, true);
assert.equal(textColor('使用我的收藏'), theme.colors.brand.primary);
assert.equal(textColor('我的默认气泡'), theme.colors.text.primary);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '编辑我的收藏' }).findByType('Pencil').props.color, theme.colors.brand.primary);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '删除我的收藏' }).findByType('Trash2').props.color, theme.colors.brand.primary);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '编辑AI 收藏' }).findByType('Pencil').props.color, theme.colors.text.secondary);
await press('我的默认气泡');
act(() => { renderer.update(React.createElement(Management, managementProps)); });
assert.equal(textColor('我的默认气泡'), theme.colors.brand.primary);
assert.equal(textColor('使用我的收藏'), theme.colors.text.primary);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '编辑我的收藏' }).findByType('Pencil').props.color, theme.colors.text.secondary);
assert.equal(renderer.root.findByProps({ accessibilityLabel: '删除我的收藏' }).findByType('Trash2').props.color, theme.colors.text.secondary);
await press('新建AI 的气泡组合');
assert.deepEqual(editCalls.at(-1), ['ai', null]);
await press('删除我的收藏');
await act(async () => managementDialogs.at(-1).buttons.find(item => item.style === 'destructive').onPress());
assert.deepEqual(removalCalls, ['mine']);
assert.deepEqual(selectionCalls, [['user', 'mine'], ['user', null]], '删除不额外切换另一侧');
act(() => renderer.unmount());

// 装饰拖动保留落点，最近角仅负责长短消息中的跟随；中断不提交。
function pan() {
  const gesture = { handlers: {} };
  for (const field of ['enabled', 'minDistance', 'runOnJS']) gesture[field] = () => gesture;
  for (const field of ['onStart', 'onUpdate', 'onEnd', 'onFinalize']) gesture[field] = callback => { gesture.handlers[field] = callback; return gesture; };
  return gesture;
}
const { BubbleDecorationLayer, bubbleDecorationStyle, bubbleDecorationOverflow } = load('src/features/chat/appearance/presentation/BubbleDecorationLayer.tsx', {
  ...base, 'react-native-gesture-handler': { Gesture: { Pan: pan }, GestureDetector: 'Gesture' },
  '../application/ChatBubbleSkinRuntime': { reportBubbleSkinLoadError: () => {} },
});
const decorationChanges = [];
let nativeDecorationBounds = { width: 200, height: 120 };
const decorationNode = () => ({ measure: callback => callback(0, 0, nativeDecorationBounds.width, nativeDecorationBounds.height, 0, 0) });
const resizeDecoration = (width, height) => {
  nativeDecorationBounds = { width, height };
  act(() => renderer.root.findByType('View').props.onLayout());
};
const bleedDecoration = { id: 'bleed', uri: 'file:///bleed.png', width: 120, height: 90,
  config: { ...domain.DEFAULT_BUBBLE_DECORATION_CONFIG, anchor: 'top-left', offsetY: -12 } };
const bottomBleed = { ...bleedDecoration, id: 'bottom', config: { ...bleedDecoration.config, anchor: 'bottom-right', offsetY: -20 } };
assert.deepEqual(bubbleDecorationOverflow([bleedDecoration, bottomBleed], { width: 200, height: 120 }), { top: 12, bottom: 20 }, '多个装饰按最大溢出量占位，不重复累加');
assert.deepEqual(bubbleDecorationOverflow([bleedDecoration, bottomBleed], { width: 20, height: 12 }), { top: 3, bottom: 5 }, '短气泡占位与装饰使用相同比例');
assert.deepEqual(bubbleDecorationOverflow([{ ...bleedDecoration, uri: null }], { width: 200, height: 120 }), { top: 0, bottom: 0 }, '不可用的装饰不留空位');
assert.deepEqual(bubbleDecorationOverflow([], { width: 200, height: 120 }), { top: 0, bottom: 0 });
function DecorationHarness() {
  const [decoration, setDecoration] = React.useState({ id: 'star', uri: 'file:///star.png', width: 120, height: 90,
    config: domain.DEFAULT_BUBBLE_DECORATION_CONFIG });
  return React.createElement(BubbleDecorationLayer, { decorations: [decoration], editing: {
    selectedId: 'star', disabled: false, onSelect: () => {}, onChange: (_id, config) => {
      decorationChanges.push(config); setDecoration(before => ({ ...before, config }));
    },
  } });
}
act(() => { renderer = create(React.createElement(DecorationHarness), { createNodeMock: decorationNode }); });
assert.equal(renderer.root.findByType('Image').props.style[0].width, 64, '首次提交已完成同步测量，不等迟到的布局事件');
const dragDecoration = (x, y, success = true) => {
  const gesture = renderer.root.findByType('Gesture').props.gesture;
  act(() => { gesture.handlers.onStart(); });
  act(() => { gesture.handlers.onUpdate({ translationX: x, translationY: y }); });
  const before = decorationChanges.length;
  act(() => { gesture.handlers.onEnd({ translationX: x, translationY: y }, success); gesture.handlers.onFinalize(); });
  return decorationChanges.length - before;
};
assert.equal(dragDecoration(150, -100), 1);
assert.equal(decorationChanges.at(-1).anchor, 'top-right');
assert.equal(decorationChanges.at(-1).offsetX, -14, '切换跟随角时保留横向破形落点');
assert.equal(decorationChanges.at(-1).offsetY, -28, '松手不会把外溢位置吸回气泡');
assert.equal(dragDecoration(-150, 100, false), 0, '系统中断不提交临时拖动位置');
assert.equal(dragDecoration(-150, 100), 1);
assert.equal(decorationChanges.at(-1).anchor, 'bottom-left');
assert.equal(dragDecoration(0, -100), 1);
assert.equal(decorationChanges.at(-1).anchor, 'top-left');
assert.equal(dragDecoration(150, 100), 1);
assert.equal(decorationChanges.at(-1).anchor, 'bottom-right');
assert.equal(dragDecoration(0, 0), 0, '点击只选择装饰，不修改既有配置');
assert.equal(dragDecoration(-330, -210), 1);
const outside = decorationChanges.at(-1);
assert.equal(outside.anchor, 'top-left');
assert.equal(outside.offsetX, -180);
assert.equal(outside.offsetY, -138);
assert.deepEqual(domain.parseBubbleDecorationConfig(outside), outside, '落点超出旧 64dp 限制仍然允许保存');
const countBeforeResize = decorationChanges.length;
resizeDecoration(20, 20);
assert.equal(decorationChanges.length, countBeforeResize, '适配短气泡不重写保存的创作参数');
assert.equal(renderer.root.findByType('Image').props.style[0].width, 20);
assert.equal(renderer.root.findByType('Image').props.style[0].height, 15);
assert.equal(renderer.root.findByType('Image').props.style[0].left, -56.25, '破形偏移随装饰一起缩小');
assert.equal(bubbleDecorationStyle({ width: 120, height: 90, config: outside }, { width: 200, height: 120 }).left, -180);

// 短气泡上拖动时，屏幕位移先换算回最大尺寸下的偏移；改回长气泡仍保持同一设计比例。
assert.equal(dragDecoration(10, 10), 1);
const shortDrop = decorationChanges.at(-1);
assert.equal(shortDrop.offsetX, -148);
assert.equal(shortDrop.offsetY, -106);
assert.equal(renderer.root.findByType('Image').props.style[0].left, -46.25, '短气泡的松手位置不跳回或缩放两次');
resizeDecoration(200, 120);
assert.equal(renderer.root.findByType('Image').props.style[0].width, 64);
assert.equal(renderer.root.findByType('Image').props.style[0].left, -148);
act(() => renderer.unmount());

// 普通消息同样按实际尺寸显示，不挂编辑手势，不把测量结果写回组合或列表。
nativeDecorationBounds = { width: 20, height: 20 };
act(() => { renderer = create(React.createElement(BubbleDecorationLayer, { decorations: [{ id: 'normal', uri: 'file:///normal.png',
  width: 120, height: 90, config: domain.DEFAULT_BUBBLE_DECORATION_CONFIG }] }), { createNodeMock: decorationNode }); });
assert.equal(renderer.root.findByType('Image').props.style.width, 20);
assert.equal(renderer.root.findByType('Image').props.style.height, 15);
assert.equal(renderer.root.findAllByType('Gesture').length, 0);
assert.equal(renderer.root.findByType('View').props.pointerEvents, 'none');
resizeDecoration(200, 120);
act(() => renderer.root.findByType('View').props.onLayout({ nativeEvent: { layout: { width: 20, height: 20 } } }));
assert.equal(renderer.root.findByType('Image').props.style.width, 64, '迟到的旧尺寸事件不把装饰切回旧位置');
assert.equal(renderer.root.findByType('Image').props.style.width, 64);
act(() => renderer.unmount());
const portraitStyle = bubbleDecorationStyle({ width: 90, height: 120, config: domain.DEFAULT_BUBBLE_DECORATION_CONFIG }, { width: 200, height: 12 });
assert.equal(portraitStyle.height, 12, '竖装饰同样受短气泡的高度约束');
assert.equal(portraitStyle.width, 9);
console.log('气泡组合管理及装饰：单侧列表、独立操作、破形落点保留、最近角跟随与中断验证通过。');
