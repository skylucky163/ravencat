/** 真实页面和公共语音条验证：只替代资料、数据库、文件与原生播放器边界。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const entries = [
  { id: 'user', speaker: 'user', inputKind: 'speech', text: '你好呀！！！', mediaAssetId: 'user', durationMs: 2300 },
  { id: 'ai-1', speaker: 'ai', inputKind: 'speech', text: '你好！很高兴认识你！', mediaAssetId: 'ai-1', durationMs: 13420 },
  { id: 'ai-2', speaker: 'ai', inputKind: 'speech', text: '今天天气不错。', mediaAssetId: 'ai-2', durationMs: 11330 },
  { id: 'text', speaker: 'user', inputKind: 'text', text: '今天过得很好哦。', mediaAssetId: null, durationMs: null },
];
const pass = ({ children }) => children;
const theme = { colors: { brand: { primary: 'blue' }, text: { primary: 'black', secondary: 'grey' },
  background: { screen: 'screen-background' }, border: { default: 'grey', light: 'silver' }, feedback: { error: 'red' } },
  spacing: { lg: 20, md: 12, sm: 8 }, radius: { lg: 16, md: 8 } };
let focused = true, activeCall = null, listener, delayedStart, started;
let nickname = 'D老师', userName = '枫渡';
let emptyHistory = false;
const historyErrors = [];
const sessions = [], dialogs = [], marked = [];
const nativePlayer = { async play(uri) {
  let snapshot = { state: 'playing', positionMs: 0, durationMs: 2300 };
  const session = { uri, stops: 0, pauses: 0, resumes: 0,
    async stop() { this.stops++; },
    async pause() { this.pauses++; snapshot = { ...snapshot, state: 'paused' }; this.emit(snapshot); },
    async resume() { this.resumes++; snapshot = { ...snapshot, state: 'playing' }; this.emit(snapshot); },
    subscribe(callback) { this.emit = callback; callback(snapshot); return () => {}; },
  };
  sessions.push(session);
  if (delayedStart) { started?.(); await new Promise(resolve => { session.finishStart = resolve; }); }
  return session;
} };
const dependencies = {
  react: React,
  'react/jsx-runtime': await import('react/jsx-runtime'),
  'react-native': {
    ActivityIndicator: 'loading', Pressable: 'button', Text: 'text', View: 'view', Image: 'image',
    StyleSheet: { create: value => value, hairlineWidth: 0.5 },
    FlatList: ({ data, renderItem, ListHeaderComponent, ListFooterComponent, ListEmptyComponent }) => React.createElement('list', null,
      ListHeaderComponent, data.length ? data.map(item => React.createElement(React.Fragment, { key: item.id }, renderItem({ item }))) : ListEmptyComponent, ListFooterComponent),
  },
  '@react-navigation/native': { useFocusEffect(effect) { const visible = focused; React.useEffect(() => visible ? effect() : undefined, [effect, visible]); } },
  'react-native-safe-area-context': { SafeAreaView: 'screen' },
  'lucide-react-native': { Pause: 'pause-icon', Play: 'play-icon', AlertCircle: 'error-icon', Trash2: 'trash-icon' },
  '@shared/theme': { ThemedSurface: pass, useTheme: () => theme, useThemedStyles: factory => factory(theme) },
  '@shared/ui': { NavigationHeader: 'header', showAppDialog(options) { dialogs.push(options); } },
  '../application/CallHistory': { async getCallHistory() { return { record: { title: '2026-10-24 12:30:00' }, entries: emptyHistory ? [] : entries, errors: historyErrors,
    images: [{ id: 'photo', callId: 'call', mediaAssetId: 'photo', createdAt: '2026-10-24T12:30:00Z' }] }; } },
  '../../application/CallHistory': { async deleteCallHistoryImage(...args) { assert.deepEqual(args, ['photo', 'call', 'ai']); } },
  '../application/runtime/AICallRuntimeService': { aiCallRuntimeService: {
    getActiveCallSnapshot: () => activeCall,
    subscribeActiveCall(callback) { listener = callback; return () => { listener = null; }; },
  } },
  '@features/media': { async resolveMediaAsset(id) { return { localUri: `file:///${id}.wav` }; } },
  '@features/profile': { async getCurrentUserProfile() { return { name: userName }; } },
  './LocalAudioPlayback': { localAudioPlaybackPort: nativePlayer },
  './MarkVoiceMessagePlayed': { async markVoiceMessagePlayed(id) { marked.push(id); } },
  './infrastructure/SQLiteAssistantRepository': {},
};
function load(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    assert.ok(Object.hasOwn(dependencies, id), `缺少 IO 边界：${id}`); return dependencies[id];
  }, module, module.exports);
  return module.exports;
}
const playbackModule = load('src/platform/device/LocalAudioPlaybackCoordinator.ts');
dependencies['@platform/device'] = playbackModule;
const displayNames = load('src/features/assistants/AssistantNickname.ts');
dependencies['@features/assistants'] = { getAssistantDisplayName: displayNames.getAssistantDisplayName,
  async getAIAssistantById() { return { id: 'ai', name: '深潜', nickname }; } };
dependencies['@shared/ui'].AudioPlaybackBar = load('src/shared/ui/AudioPlaybackBar.tsx').default;
const historyStyles = load('src/features/calls/presentation/callHistoryStyles.ts');
dependencies['./callHistoryStyles'] = historyStyles;
dependencies['../callHistoryStyles'] = historyStyles;
dependencies['../../application/runtime/AICallRuntimeService'] = dependencies['../application/runtime/AICallRuntimeService'];
dependencies['./components/CallHistoryImages'] = load('src/features/calls/presentation/components/CallHistoryImages.tsx');
dependencies['./components/CallHistoryEntryCard'] = load('src/features/calls/presentation/components/CallHistoryEntryCard.tsx');
const Screen = load('src/features/calls/presentation/CallHistoryDetailScreen.tsx').default;
const tree = () => React.createElement(Screen, { assistantId: 'ai', callId: 'call', onBack() {} });
let renderer;
const buttons = () => renderer.root.findAllByType('button').filter(button => button.props.accessibilityRole === 'button');
try {
  await act(async () => { renderer = create(tree()); });
  const content = JSON.stringify(renderer.toJSON());
  for (const value of ['枫渡', 'D老师', '语音识别转写：', '你好呀！！！', '今天过得很好哦。']) assert.ok(content.includes(value));
  assert.equal(renderer.root.findByType('screen').props.style.backgroundColor, 'screen-background');
  const durationTexts = renderer.root.findAllByType('text').map(node => node.children.join(''));
  for (const duration of ['0:03', '0:14', '0:12']) assert.ok(durationTexts.includes(duration));
  assert.equal(buttons().length, 3, '每段音频独立显示聊天语音条，用户文字没有播放按钮');
  assert.equal(buttons()[0].props.accessibilityLabel, '播放枫渡的语音');
  assert.equal(buttons()[1].props.accessibilityLabel, '播放D老师的语音');
  assert.equal(renderer.root.findAllByType('image').length, 1);
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: '删除截图' }).props.onPress(); });
  await act(async () => { await dialogs.at(-1).buttons.find(button => button.style === 'destructive').onPress(); });
  assert.equal(renderer.root.findAllByType('image').length, 0);
  assert.equal(buttons().length, 3);
  await act(async () => { buttons()[0].props.onPress(); });
  assert.equal(sessions[0].uri, 'file:///user.wav');
  await act(async () => { buttons()[0].props.onPress(); });
  assert.equal(sessions[0].pauses, 1);
  await act(async () => { buttons()[0].props.onPress(); });
  assert.equal(sessions[0].resumes, 1, '同一片段继续播放，不重新打开文件');
  assert.equal(sessions.length, 1);
  await act(async () => { buttons()[1].props.onPress(); });
  assert.equal(sessions[0].stops, 1);
  assert.equal(sessions[1].uri, 'file:///ai-1.wav');
  await act(async () => { sessions[1].emit({ state: 'ended', positionMs: 13420, durationMs: 13420 }); });
  assert.equal(sessions[1].stops, 1);

  delayedStart = true;
  const starting = new Promise(resolve => { started = resolve; });
  await act(async () => { buttons()[2].props.onPress(); await starting; });
  await act(async () => { focused = false; renderer.update(tree()); });
  await act(async () => { sessions[2].finishStart(); });
  assert.equal(sessions[2].stops, 1, '页面失焦后才返回的原生播放回执同样停止');

  delayedStart = false;
  nickname = null; userName = '枫枫';
  await act(async () => { focused = true; renderer.update(tree()); });
  assert.equal(buttons()[0].props.accessibilityLabel, '播放枫枫的语音');
  assert.equal(buttons()[1].props.accessibilityLabel, '播放深潜的语音', '未设置昵称时使用 AI 公开名称');
  await act(async () => { buttons()[0].props.onPress(); });
  await act(async () => { activeCall = { id: 'new-call' }; listener(); });
  assert.equal(sessions.at(-1).stops, 1);
  await act(async () => { buttons()[1].props.onPress(); });
  assert.match(dialogs.at(-1).message, /结束当前通话/);
  activeCall = null;
  await act(async () => { buttons()[0].props.onPress(); });
  const historySession = sessions.at(-1);
  const chat = load('src/features/chat/messages/application/VoiceMessagePlaybackCoordinator.ts').voiceMessagePlaybackCoordinator;
  await act(async () => { await chat.toggle({ kind: 'message', id: 42, isIncoming: true }, 'chat-audio', 1000); });
  assert.equal(historySession.stops, 1, '聊天和通话历史共享播放互斥');
  assert.deepEqual(marked, [42], '只有聊天的来信语音标记已播放');
  const chatSession = sessions.at(-1);
  await act(async () => { renderer.unmount(); });
  assert.equal(chatSession.stops, 0, '历史页退出不能停止已被聊天接管的播放器');
  assert.equal(listener, null);
  await chat.stop();

  emptyHistory = true;
  historyErrors.push({ id: 'failure', createdAt: '2026-10-24T12:30:01Z',
    text: '原生通话建立失败（等待当前音频端点）：系统通话音频建立超时' });
  await act(async () => { renderer = create(tree()); });
  assert.ok(JSON.stringify(renderer.toJSON()).includes('这通电话没有留下对话内容'));
  assert.ok(JSON.stringify(renderer.toJSON()).includes(historyErrors[0].text), '空记录仍展示原生失败原因');
  await act(async () => { renderer.root.findByProps({ accessibilityLabel: '查看通话异常详情' }).props.onPress(); });
  assert.match(dialogs.at(-1).message, /通话 ID：call/);
  assert.ok(dialogs.at(-1).message.includes(historyErrors[0].text));
  await act(async () => { renderer.unmount(); });

  let stopped = 0, unsubscribed = 0;
  const immediateEnd = new playbackModule.LocalAudioPlaybackCoordinator({ async play() {
    return { async stop() { stopped++; }, subscribe(callback) {
      callback({ state: 'ended', positionMs: 1, durationMs: 1 }); return () => { unsubscribed++; };
    } };
  } });
  await immediateEnd.toggle({ key: 'short', scope: 'short', durationMs: 1, resolveUri: async () => 'file:///short.wav' });
  assert.equal(stopped, 1);
  assert.equal(unsubscribed, 1, '原生同步返回已播完的短音频也要释放订阅');
} finally {
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
}
console.log('通话历史回放验证通过：主题背景、双方姓名与昵称、共用语音条、暂停/继续、跨页面互斥及生命周期。');
