/** React 真正重挂载与异步读取竞态；无计时刷新，也不轮询数据库或推动执行。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

global.IS_REACT_ACT_ENVIRONMENT = true;
const requests = [];
const buses = new Set();
const appListeners = new Set();
const intervals = new Set();
const realSetInterval = global.setInterval;
const realClearInterval = global.clearInterval;
global.setInterval = callback => { intervals.add(callback); return callback; };
global.clearInterval = callback => intervals.delete(callback);
const code = ts.transpileModule(fs.readFileSync(new URL('../../../src/features/chat/presentation/messages/ChatDetail/useChatTurnExecutionStatus.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
const mocks = {
  react: React,
  'react-native': { AppState: { addEventListener(_name, listener) { appListeners.add(listener); return { remove: () => appListeners.delete(listener) }; } } },
  '../../../reply/application/ChatTurnPresentationRuntime': { getChatTurnExecutionStatus: sessionId => new Promise((resolve, reject) => requests.push({ sessionId, resolve, reject })) },
  '../../../messages/events/ChatEvents': { setChatEventBus: bus => { buses.add(bus); return () => buses.delete(bus); } },
};
new Function('require', 'module', 'exports', code)(id => { assert.ok(Object.hasOwn(mocks, id), id); return mocks[id]; }, module, module.exports);
const { useChatTurnExecutionStatus, formatChatTurnExecutionStatus } = module.exports;
const at = new Date().toISOString();
const status = phase => ({ phase, at });
const event = (sessionId, name = 'turnExecutionChanged') => { for (const bus of buses) bus.emit(name, { sessionId }); };
let text;
let canStop;
function Surface({ sessionId }) {
  ({ statusText: text, canStop } = useChatTurnExecutionStatus(sessionId));
  return null;
}
let surface;
try {
  // 使用真实 Header 验证状态替换标题，完成后恢复名字，不增加第二行状态。
  let moonKimi = false;
  const theme = { components: { navigation: { titleColor: '#000', backgroundColor: '#fff', borderColor: '#ddd' } },
    colors: { text: { secondary: '#666', primary: '#000' }, brand: { primary: '#09f' } }, spacing: { sm: 8 }, typography: { title: { fontSize: 17 } } };
  const headerModule = { exports: {} };
  const headerCode = ts.transpileModule(fs.readFileSync(new URL('../../../src/features/chat/presentation/messages/components/ChatHeader.tsx', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const headerMocks = { react: React, 'react/jsx-runtime': jsxRuntime,
    'react-native': { View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity', StyleSheet: { create: value => value } },
    '@expo/vector-icons': { Ionicons: () => null },
    'lucide-react-native': Object.fromEntries(['ChevronRight', 'Menu', 'Volume2', 'VolumeX'].map(name => [name, () => null])),
    '@shared/theme': { isMoonKimiTheme: () => moonKimi, ThemedSurface: 'ThemedSurface', useTheme: () => theme, useThemedStyles: factory => factory(theme) } };
  new Function('require', 'module', 'exports', headerCode)(id => { assert.ok(Object.hasOwn(headerMocks, id), id); return headerMocks[id]; }, headerModule, headerModule.exports);
  let header;
  for (const moon of [false, true]) {
    moonKimi = moon;
    await act(async () => { header = create(React.createElement(headerModule.exports.default, { aiName: 'D老师', statusText: '正在执行工具' })); });
    assert.equal(header.root.findAllByType('Text')[0].props.children, '正在执行工具');
    assert.equal(header.root.findAllByType('Text').some(node => node.props.children === 'D老师'), false);
    await act(async () => header.update(React.createElement(headerModule.exports.default, { aiName: 'D老师', statusText: null, isTyping: true })));
    assert.equal(header.root.findAllByType('Text')[0].props.children, 'D老师', '真实状态结束时不能回退到残留 typing 提示');
    await act(async () => header.unmount());
  }
  moonKimi = false;
  await act(async () => { header = create(React.createElement(headerModule.exports.default, { aiName: '群聊', isTyping: true })); });
  assert.deepEqual(header.root.findAllByType('Text').map(node => node.props.children), ['对方正在输入...'], '未接入普通单聊运行状态的消费者保留原 typing 契约');
  await act(async () => header.unmount());
  await act(async () => { surface = create(React.createElement(Surface, { sessionId: 'a' })); });
  assert.equal(requests.length, 1);
  await act(async () => requests[0].resolve(status('waiting_host')));
  assert.equal(text, null, '用户发送已有气泡反馈，消息提交不占用顶部名字');
  assert.equal(canStop, true, '宿主尚未领取也能主动终止');
  await act(async () => event('a'));
  await act(async () => requests[1].resolve(status('host_started')));
  assert.equal(text, null, '执行宿主启动属于内部交接，不显示给用户');
  assert.equal(canStop, true);
  await act(async () => event('a'));
  const pendingRead = requests.length - 1;
  await act(async () => event('unrelated'));
  assert.equal(requests.length, pendingRead + 1);
  await act(async () => {
    for (let i = 0; i < 30; i++) event('a');
    for (const name of ['messagesUpdated', 'messagesReloadRequested', 'typingStatusChanged', 'regenerationChanged']) event('a', name);
  });
  assert.equal(requests.length, pendingRead + 1, '在途状态读取期间合并新事件，消息与 typing 不再驱动重复查询');
  await act(async () => requests[pendingRead].resolve(status('waiting_model')));
  assert.equal(requests.length, pendingRead + 2, '新事实不能被合并丢失，旧读取结束后重读一次');
  assert.equal(text, null, '迟到读取不能覆盖较新的持久事实');
  await act(async () => requests.at(-1).resolve(status('executing_tool')));
  assert.equal(text, '正在执行工具');
  assert.equal(canStop, true, '工具循环期间仍可终止后续输出');
  await act(async () => event('a'));
  await act(async () => requests.at(-1).resolve(status('receiving_model')));
  assert.equal(text, '正在接收模型输出');
  assert.equal(canStop, true);
  for (const phase of ['committing', 'delivering', 'closing']) {
    await act(async () => event('a'));
    await act(async () => requests.at(-1).resolve(status(phase)));
    assert.equal(text, null, '模型生成已结束后的保存、交付与清理不占用顶部名字');
    assert.equal(canStop, false, '终止入口随生成结束关闭，不等待数据库提交或交付完成');
  }
  await act(async () => event('a'));
  await act(async () => requests.at(-1).resolve(status('waiting_model')));
  assert.equal(canStop, true, '新的模型生成开始后重新显示终止入口');
  const reads = requests.length;
  await act(async () => {
    for (const name of ['messagesUpdated', 'messagesReloadRequested', 'typingStatusChanged', 'regenerationChanged']) event('a', name);
  });
  assert.equal(requests.length, reads, '已空闲时也不应由展示或输入动画事件读取执行状态');
  await act(async () => { for (const callback of intervals) callback(); });
  assert.equal(requests.length, reads, '无新事件计时不得查询数据库');
  await act(async () => surface.update(React.createElement(Surface, { sessionId: 'b' })));
  assert.equal(text, null, '切换会话不能短暂显示旧会话状态');
  assert.equal(canStop, false, '不能将旧会话的终止入口带到新会话');
  await act(async () => requests.at(-1).resolve(status('request_failed')));
  assert.equal(text, null, '模型失败由原有错误流程处理，标题恢复名字');
  assert.equal(canStop, false);
  assert.equal(intervals.size, 0);
  await act(async () => { for (const listener of appListeners) listener('active'); });
  await act(async () => requests.at(-1).resolve(status('interrupted')));
  assert.equal(text, null, '执行结束后不能把终态永久挂在标题');
  assert.equal(canStop, false);
  await act(async () => event('b'));
  const abandoned = requests.at(-1);
  await act(async () => surface.unmount());
  assert.equal(buses.size, 0);
  assert.equal(appListeners.size, 0);
  await act(async () => { surface = create(React.createElement(Surface, { sessionId: 'b' })); });
  await act(async () => abandoned.resolve(status('waiting_model')));
  assert.equal(text, null);
  await act(async () => requests.at(-1).resolve(status('delivering')));
  assert.equal(text, null, '重进页面时已结束生成的回复不显示内部交付阶段');
  assert.equal(canStop, false, '交付尚未结束不代表模型仍在输出');
  await act(async () => event('b'));
  const originalError = console.error;
  const readErrors = [];
  console.error = (...args) => readErrors.push(args);
  try { await act(async () => requests.at(-1).reject(new Error('sqlite-status-read-failed'))); }
  finally { console.error = originalError; }
  assert.equal(readErrors.length, 1, '状态读取失败保留诊断');
  assert.equal(text, null, '状态读取失败不能增加标题兜底或保留旧运行阶段');
  assert.equal(canStop, false);
  assert.equal(formatChatTurnExecutionStatus({ phase: 'waiting_model', at: '2026-10-15T00:00:00Z' }), '等待模型响应');
  assert.equal(formatChatTurnExecutionStatus({ ...status('failed'), reason: 'execution_host_start_rejected' }), null);
  assert.equal(formatChatTurnExecutionStatus({ ...status('interrupted'), reason: 'display_interrupted' }), null);
  assert.equal(formatChatTurnExecutionStatus({ ...status('failed'), reason: 'execution_host_timeout' }), null);
  assert.equal(intervals.size, 0, '运行状态不再注册每秒刷新计时器');
  console.log('运行状态：事实事件合并、迟到读隔离、前后台重读、重进页面及无计时刷新通过。');
} finally {
  if (surface) await act(async () => surface.unmount());
  global.setInterval = realSetInterval;
  global.clearInterval = realClearInterval;
}
