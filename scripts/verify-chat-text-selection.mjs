/** 验证局部选字与整条复制的菜单入口，以及可跨段落复制的原文。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import { chatSharingDependencies } from './helpers/chat-sharing-fixture.mjs';

const root = path.resolve(import.meta.dirname, '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function load(file, dependencies = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', code)(module, module.exports, name => {
    if (name === 'react') return React;
    assert.ok(Object.hasOwn(dependencies, name), `未声明依赖：${name}`);
    return dependencies[name];
  });
  return module.exports;
}

let theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const native = {
  Modal: 'Modal', View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  TouchableWithoutFeedback: 'TouchableWithoutFeedback', StyleSheet: { create: value => value },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
};
const themeApi = { useTheme: () => theme, useThemedStyles: factory => factory(theme) };
const Menu = load('src/features/chat/presentation/messages/components/ChatMessageActionMenu.tsx', {
  'react-native': native, '@shared/theme': themeApi,
  '@expo/vector-icons': { Ionicons: 'Ionicons' },
  'lucide-react-native': { History: 'History', Pin: 'Pin', PinOff: 'PinOff', Star: 'Star', TextSelect: 'TextSelect' },
}).default;
const Sheet = load('src/features/chat/presentation/messages/components/ChatMessageTextSelectionSheet.tsx', {
  'react-native': native, '@shared/theme': themeApi, '@shared/ui': { ModalSheet: 'ModalSheet' },
  '@platform/device': { TextSelectionScrollView: 'TextSelectionScrollView' },
}).default;
const calls = [];
let menu;
const menuProps = {
  visible: true, position: { x: 200, y: 500 }, onClose: () => calls.push('close-menu'),
  onCopy: () => calls.push('copy-whole-message'), onSelectText: () => calls.push('open-selection'),
};
await act(async () => { menu = create(React.createElement(Menu, menuProps)); });
const buttons = menu.root.findAllByType('TouchableOpacity');
assert.deepEqual(buttons.map(button => button.props.accessibilityLabel), [
  '复制', '选择文字', '改写', '重写', '历史版本', '删除', '多选', '固定', '转文字', '引用', '翻译', '分享', '收藏',
], '选择文字紧邻复制，其余操作保持相对顺序');
assert.equal(menu.root.findByType('Modal').props.visible, true);
await act(async () => buttons.find(button => button.props.accessibilityLabel === '选择文字').props.onPress());
assert.deepEqual(calls, ['open-selection', 'close-menu'], '选字入口交给独立窗口，然后关闭原菜单');
calls.length = 0;
await act(async () => buttons[0].props.onPress());
assert.deepEqual(calls, ['copy-whole-message', 'close-menu'], '原复制按钮继续复制整条消息');
await act(async () => menu.update(React.createElement(Menu, { ...menuProps, onSelectText: undefined })));
assert.equal(menu.root.findAllByType('TouchableOpacity').find(button => button.props.accessibilityLabel === '选择文字').props.disabled, true, '没有可选正文时由入口禁用能力');
await act(async () => menu.unmount());

const original = '  第一段原文\n\n**第二段**\n最后一行  ';
let sheet;
const close = () => calls.push('close-selection');
await act(async () => { sheet = create(React.createElement(Sheet, { text: original, onClose: close })); });
const selectable = sheet.root.findAllByType('Text').filter(node => node.props.selectable);
assert.equal(selectable.length, 1, '整条消息在同一个原生选区内，支持跨段落拖动');
assert.equal(selectable[0].props.children, original, '保留原文空格、换行和 Markdown 标记，与整条复制的内容一致');
assert.equal(sheet.root.findAllByType('TextSelectionScrollView').length, 1);
assert.equal(sheet.root.findAllByType('TextInput').length, 0, '选字是只读操作，不创建编辑输入');
assert.equal(sheet.root.findByType('ModalSheet').props.avoidKeyboard, undefined, '选择窗口不请求键盘');
assert.equal(selectable[0].props.style.color, theme.colors.text.primary);
theme = load('src/shared/theme/themes/defaultDark.ts').defaultDarkTheme;
await act(async () => sheet.update(React.createElement(Sheet, { text: original, onClose: close })));
assert.equal(sheet.root.findAllByType('Text').find(node => node.props.selectable).props.style.color, theme.colors.text.primary);
await act(async () => sheet.root.findByType('ModalSheet').props.onClose());
assert.equal(calls.at(-1), 'close-selection');
await act(async () => sheet.unmount());

// 使用真实页面接通长按、菜单、剪贴板与选字窗口，区分生成投影与已结束消息。
const domain = 'src/features/chat/messages/domain/';
const metadata = load(`${domain}chatMessageMetadata.ts`, {
  ...chatSharingDependencies, './ChatSticker': load(`${domain}ChatSticker.ts`),
});
const codeBlock = load(`${domain}ChatCodeBlock.ts`);
const selectionPolicy = load(`${domain}ChatMessageSelection.ts`, { './chatMessageMetadata': metadata });
const timelineIdentity = load(`${domain}AgentTimelineIdentity.ts`);
const timeline = load('src/features/chat/messages/application/AgentTransientTimeline.ts', {
  '../domain/AgentTimelineIdentity': timelineIdentity,
});
const noop = () => {};
const component = name => ({ __esModule: true, default: name });
let copied;
let favoriteTarget;
const Detail = load('src/features/chat/presentation/messages/ChatDetail/index.tsx', {
  'react-native': { ...native, Animated: { View: 'AnimatedView' }, ToastAndroid: { show: noop } },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
  '@features/assistants': { getAssistantDisplayName: () => 'AI' },
  '@shared/ui': { showAppDialog: noop }, '@shared/theme': themeApi,
  '@platform/device': { copyTextToClipboard: text => { copied = text; } },
  '@features/integrations': {},
  '../components/ChatHeader': component('ChatHeader'),
  '../components/ChatMessageList': component('ChatMessageList'),
  '../components/ChatInputArea': component('ChatInputArea'),
  '../components/ChatMessageActionMenu': { __esModule: true, default: Menu },
  '../components/ChatMessageTextSelectionSheet': { __esModule: true, default: Sheet },
  '../components/ChatMessageEditor': component('ChatMessageEditor'),
  '../components/ChatRegenerationConfirm': component('ChatRegenerationConfirm'),
  '../components/ChatReplyVersionSheet': component('ChatReplyVersionSheet'),
  '../components/ChatContentShareSheet': component('ChatContentShareSheet'),
  '../components/ChatBackground': component('ChatBackground'),
  '../components/ChatSelectionBars': {},
  '../components/useChatMessageSelection': { useChatMessageSelection: () => ({ availableKeys: new Set(['run:interrupted-run']) }) },
  '../components/useChatMessageShare': { useChatMessageShare: () => ({ visible: false }) },
  '../components/useChatFavoriteAction': { useChatFavoriteAction: message => { favoriteTarget = message; return { toggle: noop }; } },
  '../components/useChatStickerAction': { useChatStickerAction: () => null },
  '../components/useChatSaveImagesAction': { useChatSaveImagesAction: () => undefined },
  '../components/useChatComposerSurface': { useChatComposerSurface: () => ({ dismiss: noop }) },
  '../components/chatTypes': {},
  '../components/chatStyles': { createChatDetailStyles: () => ({}) },
  './useChatDetail': { useChatDetail: () => ({ messages: [], voiceRecordingState: 'idle' }) },
  './useChatTurnExecutionStatus': { useChatTurnExecutionStatus: () => null },
  './useChatRegeneration': { useChatRegeneration: () => ({ sourceRunId: null, eligibleRunId: 'interrupted-run', versionedRunIds: ['interrupted-run'] }) },
  './useAttachmentDraft': { useAttachmentDraft: () => ({ readyAttachments: [], clearAttachment: noop }) },
  '../../../messages/domain/ChatMessageActions': load(`${domain}ChatMessageActions.ts`, {
    './chatMessageMetadata': metadata, './ChatCodeBlock': codeBlock, './ChatAttachment': load(`${domain}ChatAttachment.ts`),
  }),
  '../../../messages/domain/ChatMessageEditing': load(`${domain}ChatMessageEditing.ts`, {
    './chatMessageMetadata': metadata, './ChatCodeBlock': codeBlock,
  }),
  '../../../messages/domain/ChatMessageSelection': selectionPolicy,
  '../../../messages/domain/ChatCodeBlock': codeBlock,
  '../../../messages/domain/chatMessageMetadata': metadata,
  '../../../messages/application/AgentTransientTimeline': timeline,
  '../../../messages/application/DeleteChatMessage': {},
  '../../../messages/application/VoiceMessagePlaybackCoordinator': { voiceMessagePlaybackCoordinator: { stop: noop } },
  '../../../conversation/application/ChatTogetherListeningGateway': { shouldShowTogetherListeningChatEntry: () => false },
  '../../../summary/application/ChatSummary': { getChatSummarySettings: async () => ({ fixedMessageId: null }) },
  '../../../summary/application/ChatSummaryRuntime': { subscribeChatSummaryChanged: () => noop },
  '../../../summary/domain/ChatContext': { projectChatContextMessage: () => ({ kind: 'dialogue' }) },
  '../../../messages/events/ChatEvents': { setChatEventBus: () => noop },
  '../../shell/ChatTextDraftProvider': { useChatTextDraft: () => ({ text: '', ready: true }) },
}).default;
let detail;
const detailProps = { session: { id: 'single' }, currentUser: { name: '用户' }, aiAssistants: [] };
await act(async () => { detail = create(React.createElement(Detail, detailProps)); });
const actionButton = label => detail.root.findAllByType('TouchableOpacity').find(node => node.props.accessibilityLabel === label);
const openMessage = async message => {
  await act(async () => detail.root.findByType('ChatMessageList').props.onMessageLongPress(message, { x: 100, y: 300 }));
  assert.equal(detail.root.findByType('Modal').props.visible, true, '展示正文长按必须打开菜单');
};
for (const status of ['streaming', 'sent']) {
  timeline.applyAgentTransientTimelineSnapshots({ sessionId: 'single', source: 'execution', snapshots: [{
    runId: 'interrupted-run', sequence: 1, stepIndex: 0, kind: 'assistant', status,
    text: original, clientMessageId: timelineIdentity.buildAgentTimelineClientMessageId('interrupted-run', 1),
    createdAt: '2026-11-11T00:00:00.000Z', time: '08:00',
  }] });
  const message = timeline.snapshotAgentTransientTimelineWithReplacements('single')[0];
  assert.ok(message.id < 0);
  await openMessage(message);
  assert.equal(favoriteTarget, null, '展示记录不以负数 ID 查询正式消息收藏');
  for (const label of ['改写', '重写', '历史版本', '删除', '多选', '固定', '引用', '翻译', '分享', '收藏']) {
    assert.equal(actionButton(label).props.disabled, true, `${label}不能把展示身份传给正式消息操作`);
  }
  await act(async () => actionButton('复制').props.onPress());
  assert.equal(copied, original, '中断正文仍可完整复制');
  await openMessage(message);
  await act(async () => actionButton('选择文字').props.onPress());
  assert.equal(detail.root.findAllByType('Modal').length, 0);
  assert.equal(detail.root.findAllByType('Text').find(node => node.props.selectable).props.children, original,
    '菜单关闭后选字窗口仍保留原文快照');
  await act(async () => detail.root.findByType('ModalSheet').props.onClose());
}
// 截断后的正文已由 owner 封存，沿用普通消息的完整菜单；生成投影不借用同轮消息身份。
const canonical = { id: 123, sessionId: 'single', text: original, senderType: 'assistant', isMe: false,
  status: 'sent', turnRunId: 'interrupted-run', turnItemIndex: 1, createdAt: '2026-11-11T00:00:00.000Z', metadataJson: '{"interrupted":true}' };
await openMessage(canonical);
assert.equal(favoriteTarget, canonical);
for (const label of ['复制', '选择文字', '改写', '重写', '历史版本', '删除', '多选', '固定', '引用', '翻译', '分享', '收藏']) {
  assert.equal(actionButton(label).props.disabled, false, `截断消息的${label}入口保持可用`);
}
await act(async () => detail.unmount());
timeline.clearAgentTransientTimelineRun('interrupted-run', 'single');

console.log('Chat text selection sheet verification passed.');
