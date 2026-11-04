/** 独立模型设置页按助手读取、状态分支与既有表单衔接行为。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, name), `${file} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const react = { ...React, default: React };
const listeners = new Set();
const requestedIds = [];
const profileA = { id: 'assistant-a', agentId: 'agent-a', name: '助手 A', model: 'model-a' };
const profileB = { id: 'assistant-b', agentId: 'agent-b', name: '助手 B', model: 'model-b' };
let readResult = profileA;
let failRead = false;
let pendingRead = null;
const commands = {
  getAIAssistantById: id => {
    requestedIds.push(id);
    if (pendingRead) return pendingRead.promise;
    return failRead ? Promise.reject(new Error('读取失败')) : Promise.resolve(readResult);
  },
  subscribeAIAssistantUpdated: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
const { useAIAssistantProfile } = load('src/features/assistants/presentation/profile/useAIAssistantProfile.ts', {
  react,
  '../../AIAssistantManagement': commands,
});
const { default: Screen } = load('src/features/assistants/presentation/profile/AssistantModelSettingsScreen.tsx', {
  react,
  'react-native': { ActivityIndicator: 'ActivityIndicator', Text: 'Text', View: 'View' },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@shared/theme': { useThemedStyles: () => ({ screen: {}, loading: {}, empty: {} }) },
  '@shared/ui': { Button: 'Button', EmptyState: 'EmptyState' },
  '@shared/ui/NavigationHeader': { default: 'NavigationHeader' },
  '../management/AIModelSettings': { default: 'AIModelSettings' },
  './AssistantProfile.styles': { createAssistantProfileStyles: () => ({}) },
  './useAIAssistantProfile': { useAIAssistantProfile },
});

const auxiliaryModelSettings = React.createElement('AuxiliaryModelSettings', { owner: 'host' });
let backCount = 0;
const onBack = () => { backCount += 1; };
let renderer = null;
const props = aiId => ({ aiId, onBack, auxiliaryModelSettings });
const mount = async aiId => {
  await act(async () => { renderer = create(React.createElement(Screen, props(aiId))); });
};
const unmount = async () => {
  if (!renderer) return;
  const current = renderer;
  renderer = null;
  await act(async () => { current.unmount(); });
};
const modelForms = () => renderer.root.findAllByType('AIModelSettings');

try {
  pendingRead = deferred();
  await mount('assistant-a');
  assert.deepEqual(requestedIds, ['assistant-a'], '设置目标直接来自页面助手 ID');
  assert.equal(renderer.root.findAllByType('ActivityIndicator').length, 1);
  assert.equal(modelForms().length, 0, '读取期间不挂载模型表单');
  renderer.root.findByType('NavigationHeader').props.onGoBack();
  assert.equal(backCount, 1, '加载状态仍可返回');

  const initialRead = pendingRead;
  pendingRead = null;
  await act(async () => {
    initialRead.resolve(profileA);
    await initialRead.promise;
  });
  let form = renderer.root.findByType('AIModelSettings');
  assert.equal(form.props.aiAssistant, profileA);
  assert.equal(form.props.onBack, onBack);
  assert.equal(form.props.auxiliaryModelSettings, auxiliaryModelSettings, 'Host 插槽原样交给既有表单');
  form.props.onBack();
  assert.equal(backCount, 2);

  const updatedA = { ...profileA, model: 'updated-model' };
  await act(async () => {
    for (const listener of listeners) listener(updatedA);
  });
  assert.equal(renderer.root.findByType('AIModelSettings').props.aiAssistant, updatedA, '提交事实更新既有表单资料');

  readResult = profileB;
  await act(async () => { renderer.update(React.createElement(Screen, props('assistant-b'))); });
  form = renderer.root.findByType('AIModelSettings');
  assert.equal(form.props.aiAssistant, profileB, '切换助手后表单使用新目标');
  assert.deepEqual(requestedIds, ['assistant-a', 'assistant-b']);
  await unmount();
  assert.equal(listeners.size, 0);

  failRead = true;
  await mount('assistant-a');
  assert.equal(modelForms().length, 0, '读取失败不挂载可编辑模型页');
  assert.equal(renderer.root.findByType('Button').props.title, '重试');
  failRead = false;
  readResult = updatedA;
  await act(async () => { renderer.root.findByType('Button').props.onPress(); });
  assert.equal(renderer.root.findByType('AIModelSettings').props.aiAssistant, updatedA, '重试复用既有资料读取');
  await unmount();

  readResult = null;
  await mount('missing-assistant');
  assert.equal(renderer.root.findByType('EmptyState').props.title, '找不到这个 AI');
  assert.equal(modelForms().length, 0, '助手不存在不挂载模型表单');
} finally {
  await unmount();
}

assert.equal(listeners.size, 0, '页面离开后释放资料订阅');
console.log('独立模型设置页：助手目标、返回与插槽、加载/失败/重试/空目标及资料更新验证通过。');
