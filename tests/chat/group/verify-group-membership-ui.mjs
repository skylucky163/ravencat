/** 页面操作验证：成员选择、禁言菜单、历史注入与完整历史查看。 */
import { repoRoot as root } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import ts from 'typescript';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const writes = [], dialogs = [];
const record = { id: 'history', groupId: 'g', groupName: '旧群名', reason: 'removed', exitedAt: '2026-10-23T00:00:00Z', injectEnabled: true,
  context: { contextSegments: [{ content: '完整摘要'.repeat(130) }], timeline: [] } };
const commands = {
  listHistoricalGroups: async () => [record], subscribeGroupChanged: () => () => {},
  setHistoricalGroupInjection: async (...args) => { writes.push(['injection', ...args]); },
  listGroupInviteCandidates: async () => [{ id: 'new-ai', name: '新成员', avatar: null }],
  changeGroupMembers: async (...args) => { writes.push(['members', ...args]); },
};
const theme = { colors: { brand: { primary: 'blue' }, text: { secondary: 'gray', primary: 'black', tertiary: 'gray' },
  feedback: { error: 'red' }, border: { light: 'gray' } } };
function load(relative) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(root, relative), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const mocks = {
    react: React,
    'react-native': { ...Object.fromEntries(['ActivityIndicator', 'Pressable', 'ScrollView', 'Text', 'View'].map(name => [name, name])), StyleSheet: { create: value => value } },
    '@shared/theme': { ThemedSurface: 'ThemedSurface', useTheme: () => theme, useThemedStyles: () => ({}) },
    '@shared/ui': { ...Object.fromEntries(['Button', 'InputField', 'ToggleField', 'AIAvatar'].map(name => [name, name])),
      ModalSheet: props => props.visible ? React.createElement('ModalSheet', props, props.children) : null,
      showAppDialog: value => { dialogs.push(value); } },
    'lucide-react-native': { Plus: 'Plus', ChevronRight: 'ChevronRight' },
    './chatSettingsStyles': { createStyles: () => ({}) },
    '../../group/application/GroupMembership': commands,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (!(name in mocks)) throw new Error(`页面测试未声明依赖 ${name}`);
    return mocks[name];
  }, module, module.exports);
  return module.exports.default;
}
const HistoricalGroups = load('src/features/chat/presentation/conversation/HistoricalGroupsSection.tsx');
let view;
const visibleText = () => view.root.findAllByType('Text').map(node => node.children.filter(child => typeof child === 'string').join('')).join('\n');
await act(async () => { view = TestRenderer.create(React.createElement(HistoricalGroups, { assistantId: 'ai' })); });
await act(async () => { view.root.findByType('Pressable').props.onPress(); });
await act(async () => { view.root.findAllByType('Pressable').at(-1).props.onPress(); });
assert.ok(visibleText().includes('已被移出该群聊'));
await act(async () => { await view.root.findByType('ToggleField').props.onValueChange(false); });
assert.deepEqual(writes.at(-1), ['injection', 'ai', 'history', false]);
assert.ok(visibleText().includes(record.context.contextSegments[0].content));
assert.equal(view.root.findAllByType('InputField').length, 0);
assert.equal(view.root.findAllByType('Button').length, 0);
await act(async () => { view.unmount(); });

const Members = load('src/features/chat/presentation/group/GroupMembersSection.tsx');
await act(async () => { view = TestRenderer.create(React.createElement(Members, { groupId: 'g',
  members: [{ aiAssistantId: 'muted', name: '禁言成员', enabled: true, muted: true }] })); });
assert.ok(visibleText().includes('已禁言'));
await act(async () => { view.root.findByProps({ accessibilityLabel: '管理禁言成员' }).props.onPress(); });
assert.equal(dialogs.at(-1).buttons[0].text, '解除禁言');
await act(async () => { view.root.findByProps({ accessibilityLabel: '添加群成员' }).props.onPress(); });
await act(async () => { view.root.findByProps({ accessibilityRole: 'checkbox' }).props.onPress(); });
assert.equal(view.root.findByType('Button').props.title, '添加所选成员（1）');
await act(async () => { view.root.findByType('Button').props.onPress(); });
assert.deepEqual(writes.at(-1), ['members', 'g', 'add', ['new-ai']]);
await act(async () => { view.unmount(); });
console.log('群成员选择、禁言入口、历史注入开关与历史查看页面验证通过，手动转换入口已移除。');
