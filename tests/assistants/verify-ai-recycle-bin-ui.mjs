/** 回收站真实页面行为：恢复、二次确认、失败反馈与操作互斥。 */
import assert from 'node:assert/strict';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { load } from '../helpers/chat-message-mutation-fixture.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const item = { id: 'one', name: '公开名称', nickname: '我的 AI', avatar: null, expiresAt: '2026-11-22T00:00:00.000Z' };
let records = [item];
let listener;
let dialog;
let restores = 0;
let deletions = 0;
let cleanup = 0;
let releaseRestore;
let restoreResult = true;
const native = { ...Object.fromEntries(['ActivityIndicator', 'ScrollView', 'Text', 'TouchableOpacity', 'View', 'Image'].map(name => [name, name])), StyleSheet: { create: value => value } };
const theme = { ThemedSurface: 'Surface', useThemedStyles: () => ({}),
  useTheme: () => ({ radius: { md: 8 }, colors: { brand: { primary: '#111' }, feedback: { error: '#f00' } } }) };
const avatarConstants = load('src/shared/avatar/avatarConstants.ts');
const defaultAIAvatar = 101;
const avatarRegistry = load('src/shared/avatar/avatarRegistry.ts', {
  '../../../assets/fengdu.png': 102, '../../../assets/raven.png': defaultAIAvatar, '../../../assets/icon.png': 103,
});
const avatarSources = load('src/shared/avatar/resolveAvatarSource.ts', { '@shared': { DEFAULT_SELF_NAME: '用户' }, './avatarRegistry': avatarRegistry });
const { default: AvatarImage } = load('src/shared/ui/AvatarImage.tsx', {
  'react-native': native, '@shared/avatar/avatarConstants': avatarConstants, '@shared/theme': theme,
});
const avatarDependencies = { '@shared/avatar/avatarConstants': avatarConstants,
  '@shared/avatar/resolveAvatarSource': avatarSources, './AvatarImage': { __esModule: true, default: AvatarImage } };
const { default: AIAvatar } = load('src/shared/ui/AIAvatar.tsx', avatarDependencies);
const { default: UserAvatar } = load('src/shared/ui/UserAvatar.tsx', avatarDependencies);
const { default: Screen } = load('src/features/assistants/presentation/management/AIRecycleBinScreen.tsx', {
  'react-native': native,
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  'lucide-react-native': { RotateCcw: 'RestoreIcon', Trash2: 'TrashIcon' },
  '@shared/theme': theme,
  '@shared/ui': { AIAvatar, UserAvatar, showAppDialog: value => { dialog = value; } },
  '@shared/ui/NavigationHeader': 'Header',
  '../../AssistantNickname': { getAssistantDisplayName: value => value.nickname ?? value.name },
  '../../AIAssistantManagement': {
    listRecycledAIAssistants: async () => records,
    subscribeAssistantLifecycleChanged: callback => { listener = callback; return () => { listener = null; }; },
    restoreAIAssistant: async () => { restores++; if (releaseRestore) await new Promise(resolve => { releaseRestore = resolve; }); return restoreResult; },
    permanentlyDeleteAIAssistant: async () => { deletions++; records = []; return true; },
    purgeExpiredAIAssistants: async () => { cleanup++; records = []; },
  },
});
let mounted;
await act(async () => { mounted = create(React.createElement(Screen, { onBack() {} })); });
const buttons = () => mounted.root.findAllByType('TouchableOpacity');
const action = label => buttons().find(node => node.props.accessibilityLabel === label);
const confirmRestore = () => dialog.buttons.find(button => button.text === '恢复').onPress();
assert.equal(mounted.root.findByType('Header').props.title, 'AI 回收站');
assert.equal(mounted.root.findByType('Image').props.source, defaultAIAvatar, '回收中的 AI 仍使用 AI 默认头像');
const customAvatar = 'file:///persistent-media/ai-avatar.png';
records = [{ ...item, avatar: customAvatar }];
await act(async () => { listener(); });
assert.deepEqual(mounted.root.findByType('Image').props.source, { uri: customAvatar }, '回收站保留自定义头像');
await act(async () => { mounted.root.findByType('Image').props.onError(); });
assert.equal(mounted.root.findByType('Image').props.source, defaultAIAvatar, '自定义头像加载失败也不能变成用户头像');
assert.equal(records[0].avatar, customAvatar);
records = [item];
await act(async () => { listener(); });
await act(async () => { action('彻底删除我的 AI').props.onPress(); });
assert.equal(deletions, 0);
assert.match(dialog.message, /无法恢复/);
assert.match(dialog.message, /群聊历史、分享快照/);
assert.equal(dialog.buttons.find(button => button.style === 'cancel').onPress, undefined, '取消确认不执行删除命令');

// 恢复先询问是否恢复身份；取消不执行，确认后才进入在途恢复并阻止重入。
releaseRestore = true;
await act(async () => { action('恢复我的 AI').props.onPress(); });
assert.equal(restores, 0);
assert.equal(dialog.title, '恢复 AI 身份');
assert.match(dialog.message, /身份和全部资料/);
assert.match(dialog.message, /任命不自动恢复/);
assert.match(dialog.message, /冷静期继续计时/);
assert.equal(dialog.buttons.find(button => button.style === 'cancel').onPress, undefined, '取消确认不执行恢复命令');
await act(async () => { confirmRestore(); });
assert.equal(restores, 1);
assert.equal(action('彻底删除我的 AI').props.disabled, true);
await act(async () => { action('恢复我的 AI').props.onPress(); confirmRestore(); });
assert.equal(restores, 1);
await act(async () => { releaseRestore(); });
releaseRestore = null;
assert.equal(action('恢复我的 AI').props.disabled, false);
await act(async () => { action('彻底删除我的 AI').props.onPress(); });
await act(async () => { dialog.buttons.find(button => button.style === 'destructive').onPress(); });
assert.equal(deletions, 1);
assert.equal(action('恢复我的 AI'), undefined);

records = [item];
await act(async () => { listener(); });
restoreResult = false;
await act(async () => { action('恢复我的 AI').props.onPress(); confirmRestore(); });
assert.equal(cleanup, 1);
assert.equal(dialog.title, '无法恢复');
assert.equal(action('恢复我的 AI'), undefined);
await act(async () => { mounted.unmount(); });
assert.equal(listener, null);
console.log('AI 回收站页面验证通过：AI 默认与自定义头像、加载失败回退、恢复身份确认、彻底删除确认、到期反馈及操作互斥。');
