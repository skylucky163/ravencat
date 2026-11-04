/** 验证个人主页设置入口的可见标题与导航意图回调。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function load(relativePath, dependencies = {}) {
  const filename = path.join(root, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(name => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return jsxRuntime;
    assert.ok(Object.hasOwn(dependencies, name), `${relativePath} 缺少依赖 ${name}`);
    return dependencies[name];
  }, module, module.exports);
  return module.exports;
}

const native = {
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
  StyleSheet: { create: styles => styles, hairlineWidth: 0.5 },
};
const theme = {
  colors: {
    brand: { primary: '#123456' },
    surface: { default: '#ffffff' },
    text: { primary: '#111111', tertiary: '#777777' },
    border: { light: '#dddddd' },
  },
  effects: { glass: { enabled: false } },
  spacing: { xs: 4, sm: 8, md: 12, lg: 16 },
  radius: { lg: 16 },
};
const sharedTheme = {
  ThemedSurface: 'ThemedSurface',
  useTheme: () => theme,
  useThemedStyles: factory => factory(theme),
};
const styles = load('src/features/assistants/presentation/profile/AssistantSettingsEntries.styles.ts', {
  'react-native': native,
});
const { default: AssistantSettingsEntries } = load('src/features/assistants/presentation/profile/AssistantSettingsEntries.tsx', {
  'react-native': native,
  'lucide-react-native': {
    ChevronRight: 'ChevronRight',
    Layers3: 'Layers3',
    NotebookPen: 'NotebookPen',
    Settings2: 'Settings2',
  },
  '@shared/theme': sharedTheme,
  './AssistantSettingsEntries.styles': styles,
});

let modelSettingsClicks = 0;
let contextSettingsClicks = 0;
let summaryClicks = 0;
let renderer;
const readText = node => typeof node === 'string' ? node : node.children.map(readText).join('');
const findEntry = title => {
  const entries = renderer.root.findAll(node =>
    node.props.accessibilityRole === 'button' && node.props.accessibilityLabel === title);
  assert.equal(entries.length, 1, `${title} 应有唯一可点击入口`);
  return entries[0];
};

try {
  await act(async () => {
    renderer = create(React.createElement(AssistantSettingsEntries, {
      onOpenModelSettings: () => { modelSettingsClicks++; },
      onOpenContextSettings: () => { contextSettingsClicks++; },
      onOpenSummary: () => { summaryClicks++; },
    }));
  });

  for (const title of ['模型设置', '上下文设置', '聊天摘要']) {
    const visibleTitles = renderer.root.findAllByType('Text').filter(node => readText(node) === title);
    assert.equal(visibleTitles.length, 1, `${title} 标题应可见`);
  }

  await act(async () => { findEntry('模型设置').props.onPress(); });
  assert.equal(modelSettingsClicks, 1, '模型设置单次点击只触发一次对应回调');
  assert.equal(contextSettingsClicks, 0, '模型设置不能触发上下文设置回调');

  await act(async () => { findEntry('上下文设置').props.onPress(); });
  assert.equal(contextSettingsClicks, 1, '上下文设置单次点击只触发一次对应回调');
  assert.equal(modelSettingsClicks, 1, '上下文设置不能重复触发模型设置回调');

  await act(async () => { findEntry('聊天摘要').props.onPress(); });
  assert.equal(summaryClicks, 1);
  assert.equal(modelSettingsClicks, 1);
  assert.equal(contextSettingsClicks, 1);

  console.log('AI 个人主页设置入口验证通过：三个标题可见，点击分别且仅触发一次正确回调。');
} finally {
  if (renderer) await act(async () => { renderer.unmount(); });
}
