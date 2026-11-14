/** 作品库的加入／移出不重载网页，列表与两个宿主入口共用同一预览身份。 */
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { load } from './helpers/chat-message-mutation-fixture.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const native = {
  ActivityIndicator: 'ActivityIndicator', Image: 'Image', Pressable: 'Pressable', Text: 'Text', View: 'View', TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: value => value, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390 }),
  FlatList: ({ data, renderItem, ListEmptyComponent }) => React.createElement('List', null,
    data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: item.id }, renderItem({ item, index }))) : ListEmptyComponent),
};
const themed = { useTheme: () => theme, useThemedStyles: factory => factory(theme), ThemedSurface: 'ThemedSurface' };
const dialogs = [], writes = [];
let resolveSave;
let rejectSave;
let reloads = 0;
const preview = { id: 'version-one', agentId: 'agent-one', language: 'html', source: '<button>点我</button>',
  title: '这是一个用于验证导航栏布局的超长网页标题'.repeat(3), canRender: true, inLibrary: false, createdAt: '2026-11-11T00:00:00Z' };
function WebView({ source }) {
  const [score, setScore] = React.useState(0);
  React.useEffect(() => { reloads++; setScore(0); }, [source]);
  return React.createElement('WebView', { score, onInteract: () => setScore(value => value + 1) });
}
const safeArea = { useSafeAreaInsets: () => ({ top: 24, bottom: 16 }), SafeAreaView: 'SafeAreaView' };
const { default: NavigationHeader } = load('src/shared/ui/NavigationHeader.tsx', {
  'react-native': native, '@shared/theme': themed, 'react-native-safe-area-context': safeArea,
  '@expo/vector-icons': { Ionicons: 'Ionicons' }, './NavigationHeaderHelp': { __esModule: true, default: 'HeaderHelp' },
});
const common = {
  'react-native': native, '@shared/theme': themed,
  '@shared/ui': { NavigationHeader, showAppDialog: value => dialogs.push(value) },
  'react-native-safe-area-context': safeArea,
  '@react-navigation/native': { useIsFocused: () => true,
    useFocusEffect: callback => React.useEffect(callback, [callback]) },
};
let captureShouldFail = false;
const { default: Preview } = load('src/features/chat/presentation/messages/ChatCodePreviewScreen.tsx', {
  ...common, 'react-native-webview': { WebView }, './ChatCodeSourceView': { __esModule: true, default: 'SourceView' },
  'react-native-view-shot': { captureRef: async () => {
    if (captureShouldFail) throw new Error('RNViewShot native module is null');
    return 'file:///tmp/cover.jpg';
  } },
  'lucide-react-native': { BookmarkCheck: 'BookmarkCheck', BookmarkPlus: 'BookmarkPlus', Code2: 'Code2', Globe2: 'Globe2' },
  './chatCodePreviewDocument': load('src/features/chat/presentation/messages/chatCodePreviewDocument.ts'),
  '../../messages/application/ChatCodePreview': { getChatCodePreview: async () => ({ ...preview }),
    setChatCodeInLibrary: (id, included, cover) => { writes.push([id, included, cover ?? null]); return new Promise((resolve, reject) => { resolveSave = resolve; rejectSave = reject; }); } },
});
let screen;
await act(async () => { screen = create(React.createElement(Preview, { previewId: preview.id, onBack() {} }), { createNodeMock: () => ({}) }); });
act(() => screen.root.findByType('WebView').props.onInteract());
assert.equal(screen.root.findByType('WebView').props.score, 1);
const initialLoads = reloads;
const title = screen.root.findAllByType('Text').find(node => node.props.children === preview.title);
assert.equal(title.props.numberOfLines, 1, '长标题保持单行');
assert.equal(title.props.ellipsizeMode, 'tail', '长标题尾部省略');
act(() => screen.root.findByProps({ accessibilityLabel: '查看源码' }).props.onPress());
assert.equal(screen.root.findByType('SourceView').props.source, preview.source);
act(() => screen.root.findByProps({ accessibilityLabel: '返回网页' }).props.onPress());
assert.equal(screen.root.findByType('WebView').props.score, 1, '图标切换源码后仍保留网页交互');
await act(async () => { screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.onPress(); });
assert.deepEqual(writes.at(-1), [preview.id, true, 'file:///tmp/cover.jpg'], '收纳网页画面时同时提交封面截图');
assert.equal(screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.accessibilityState.selected, false, '保存完成前不伪造已加入状态');
assert.equal(screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.disabled, true);
await act(async () => resolveSave());
assert.equal(screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.accessibilityState.selected, true);
assert.equal(screen.root.findByType('WebView').props.score, 1, '加入作品库保留当前网页交互状态');
assert.equal(reloads, initialLoads, '收纳不重新加载网页');
await act(async () => { screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.onPress(); });
await act(async () => rejectSave(new Error('模拟保存失败')));
assert.equal(screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.accessibilityState.selected, true, '失败保留已确认的收纳状态');
assert.equal(dialogs.at(-1).title, '移出作品库失败');
assert.equal(reloads, initialLoads);
await act(async () => { screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.onPress(); });
await act(async () => resolveSave());
assert.equal(screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.accessibilityState.selected, false);
assert.equal(screen.root.findByType('WebView').props.score, 1);
// 正在查看源码时网页不可见，收纳不附带封面。
act(() => screen.root.findByProps({ accessibilityLabel: '查看源码' }).props.onPress());
await act(async () => { screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.onPress(); });
assert.deepEqual(writes.at(-1), [preview.id, true, null], '源码视图下收纳跳过截图');
await act(async () => resolveSave());
assert.equal(screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.accessibilityState.selected, true);
// 原生截图模块缺失（安装包未重建）时，失败原因必须展示，且不能阻断收纳。
act(() => screen.root.findByProps({ accessibilityLabel: '返回网页' }).props.onPress());
await act(async () => { screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.onPress(); });
await act(async () => resolveSave());
captureShouldFail = true;
await act(async () => { screen.root.findByProps({ accessibilityLabel: '加入作品库' }).props.onPress(); });
assert.deepEqual(writes.at(-1), [preview.id, true, null], '截图失败仍提交收纳');
await act(async () => resolveSave());
assert.equal(screen.root.findByProps({ accessibilityLabel: '移出作品库' }).props.accessibilityState.selected, true, '截图失败不撤销已确认的收纳');
assert.equal(dialogs.at(-1).title, '封面截图失败');
assert.match(dialogs.at(-1).message, /RNViewShot native module is null/, '弹窗带上真实失败原因');
assert.match(dialogs.at(-1).message, /手动上传封面/, '给出可操作的补救路径');
act(() => screen.unmount());

const opened = [];
const libraryListeners = new Set();
let libraryItems = [
  { id: 'version-one', title: '同名作品', coverFile: 'version-one.jpg', createdAt: preview.createdAt, addedAt: preview.createdAt },
  { id: 'version-two', title: '同名作品', coverFile: null, createdAt: preview.createdAt, addedAt: preview.createdAt },
];
let permissionGranted = true;
const uploads = [];
const { default: Library } = load('src/features/chat/presentation/messages/ChatCodeLibraryScreen.tsx', {
  ...common, 'lucide-react-native': { BookmarkMinus: 'BookmarkMinus', Globe2: 'Globe2', ImagePlus: 'ImagePlus' },
  'expo-image-picker': { requestMediaLibraryPermissionsAsync: async () => ({ granted: permissionGranted }) },
  '@platform/device/DeviceMediaService': { pickCroppedImage: async options => { uploads.push(options); return { uri: 'file:///picked/cover.jpg', width: 1600 }; } },
  './components/ChatCodeNavigation': { useOpenChatCodePreview: () => id => opened.push(id) },
  '../../messages/application/ChatCodePreview': {
    chatCodeCoverUri: file => file === null ? null : `file:///covers/${file}`,
    listChatCodeLibrary: async aiId => { assert.equal(aiId, 'ai-one'); return libraryItems.slice(); },
    subscribeChatCodeLibraryChanged: listener => { libraryListeners.add(listener); return () => libraryListeners.delete(listener); },
    updateChatCodeCover: async (id, uri, width) => { uploads.push([id, uri, width]); for (const listener of libraryListeners) listener(); },
    setChatCodeInLibrary: async (id, included) => {
      assert.equal(included, false);
      libraryItems = libraryItems.filter(item => item.id !== id);
      for (const listener of libraryListeners) listener();
    },
  },
});
await act(async () => { screen = create(React.createElement(Library, { aiId: 'ai-one', onBack() {} })); });
assert.equal(screen.root.findAllByProps({ accessibilityLabel: '打开作品：同名作品' }).length, 2);
const covers = screen.root.findAllByType('Image');
assert.equal(covers.length, 1, '没有封面的作品退回占位图标');
assert.equal(covers[0].props.source.uri, 'file:///covers/version-one.jpg', '封面文件名解析为可加载图片');
act(() => screen.root.findAllByProps({ accessibilityLabel: '打开作品：同名作品' })[1].props.onPress());
assert.deepEqual(opened, ['version-two'], '同名版本按实际预览 ID 打开');
await act(async () => { screen.root.findAllByProps({ accessibilityLabel: '移出作品库：同名作品' })[0].props.onPress(); });
assert.equal(screen.root.findAllByProps({ accessibilityLabel: '打开作品：同名作品' }).length, 1);
act(() => screen.root.findByProps({ accessibilityLabel: '打开作品：同名作品' }).props.onPress());
assert.equal(opened.at(-1), 'version-two', '移出一版不影响另一版');
await act(async () => {
  libraryItems.push({ ...libraryItems[0], id: 'version-three' });
  for (const listener of libraryListeners) listener();
});
assert.equal(screen.root.findAllByProps({ accessibilityLabel: '打开作品：同名作品' }).length, 2, '返回列表后才提交的加入操作也刷新活动作品库');
permissionGranted = false;
await act(async () => { screen.root.findAllByProps({ accessibilityLabel: '更换作品封面：同名作品' })[0].props.onPress(); });
assert.equal(dialogs.at(-1).title, '需要权限', '相册权限被拒时给出说明');
assert.equal(uploads.length, 0, '无权限不打开选图、不写封面');
permissionGranted = true;
await act(async () => { screen.root.findAllByProps({ accessibilityLabel: '更换作品封面：同名作品' })[0].props.onPress(); });
assert.deepEqual(uploads[0], { aspect: [4, 3] }, '封面按 4:3 裁剪');
assert.deepEqual(uploads[1], ['version-two', 'file:///picked/cover.jpg', 1600], '选定的封面交给 application 提交');
act(() => screen.unmount());
assert.equal(libraryListeners.size, 0);
console.log('作品库 UI 验证通过：封面截图与失败原因、源码视图跳过截图、网页交互状态保留、同名版本打开与单版移出、网格封面与占位、相册权限与自定义封面上传。');
