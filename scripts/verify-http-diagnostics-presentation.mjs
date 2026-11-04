/** 验证大正文有界阅读、分页原文完整性和请求/响应独立复制。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';

const require = createRequire(import.meta.url);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const requestBody = '请'.repeat(3999) + '📦' + '求'.repeat(3998) + '🐈' + '\r\n{"messages":[]}\n'.repeat(1000);
const responseBody = 'data: {"text":"响应📦"}\r\n\r\n'.repeat(100_000) + 'data: [DONE]\n';
const record = {
  id: 'large', startedAt: '2026-10-28T01:00:00.000Z', completedAt: '2026-10-28T01:00:01.000Z',
  url: 'https://example.com/chat/completions', method: 'POST', model: 'test-model',
  transport: 'stream', status: 200, requestBody, responseBody, error: null,
};
let dialog;
let copyFailure = false;
let diagnosticsListener = null;
let diagnosticsEnabled = true;
let diagnosticsRecords = [record, { ...record, id: 'empty', model: 'empty-model', requestBody: '', responseBody: 'data: [DONE]\n' }];
let snapshotReads = 0;
const copied = [];
// 记录行复用 ListItem，测试只关心它把标题内容和点击透出。
const ListItemStub = ({ titleContent, rightContent, onPress, style }) =>
  React.createElement('TouchableOpacity', { onPress, style }, titleContent ?? null, rightContent ?? null);
const mocks = {
  'react-native': {
    ScrollView: 'ScrollView', Text: 'Text', TouchableOpacity: 'TouchableOpacity', View: 'View',
    Animated: {
      View: 'AnimatedView',
      Value: class { setValue() {} interpolate() { return '0deg'; } },
      timing: () => ({ start() {} }),
    },
    Easing: { linear: value => value },
  },
  'lucide-react-native': { ChevronDown: 'ChevronDown', ChevronRight: 'ChevronRight', RefreshCw: 'RefreshCw' },
  'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
  '@platform/ai': { aiHttpDiagnostics: {
    getSnapshot: async () => {
      snapshotReads += 1;
      return { enabled: diagnosticsEnabled, error: null, records: diagnosticsRecords };
    },
    subscribe: listener => {
      diagnosticsListener = listener;
      return () => { diagnosticsListener = null; };
    },
    setEnabled: async enabled => {
      diagnosticsEnabled = enabled;
      diagnosticsListener();
    },
    clear: async () => {
      diagnosticsRecords = [];
      diagnosticsListener();
    },
  } },
  '@platform/device': {
    TextSelectionScrollView: 'TextSelectionScrollView',
    copyTextToClipboard: value => {
      if (copyFailure) throw new Error('剪贴板不可用');
      copied.push(value);
    },
  },
  '@shared/theme': { useTheme: () => ({ colors: { text: { secondary: 'gray' } } }), ThemedSurface: 'ThemedSurface' },
  '@shared/ui': {
    Button: 'Button', ToggleField: 'ToggleField', EmptyState: 'EmptyState', ListItem: ListItemStub,
    showAppDialog: value => { dialog = value; },
    ModalSheet: ({ visible, children }) => visible ? React.createElement('ModalSheet', null, children) : null,
  },
  '@shared/ui/NavigationHeader': { __esModule: true, default: 'NavigationHeader' },
  './AIRequestDiagnosticsScreen.styles': { createHttpDiagnosticsStyles: () => ({}) },
};
const module = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(new URL('../src/features/miniPrograms/presentation/httpDiagnostics/AIRequestDiagnosticsScreen.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;
new Function('require', 'module', 'exports', code)(id => {
  if (id === 'react' || id === 'react/jsx-runtime') return require(id);
  assert.ok(Object.hasOwn(mocks, id), `缺少依赖 ${id}`);
  return mocks[id];
}, module, module.exports);

let screen;
const texts = node => node.findAllByType('Text').map(item => item.children.join('')).join('\n');
const button = (node, title) => node.findAllByType('Button').find(item => item.props.title === title);
const toggle = label => screen.root.findAllByType('TouchableOpacity').find(item => item.props.accessibilityLabel?.startsWith(`${label}，`));
const rawTexts = () => screen.root.findAllByType('Text')
  .filter(item => item.props.selectable && item.props.accessibilityRole !== 'alert')
  .map(item => item.children.join('')).filter(value => !value.startsWith('ID：'));
const press = async node => {
  assert.ok(node, '操作入口应存在');
  assert.ok(!node.props.disabled, '操作应可用');
  await act(async () => { node.props.onPress(); });
};
const copy = async label => {
  await press(button(screen.root, `复制${label}`));
  const confirm = dialog.buttons.find(item => item.text === `复制${label}`);
  assert.ok(confirm);
  await act(async () => { confirm.onPress(); });
};
const openRecord = async id => {
  const model = id === 'large' ? 'test-model' : 'empty-model';
  await press(screen.root.findAllByType('TouchableOpacity').find(item => texts(item).startsWith(`${model} ·`)));
};

try {
  await act(async () => { screen = create(React.createElement(module.exports.AIRequestDiagnosticsScreen, { onBack() {} })); });
  await openRecord('large');
  assert.deepEqual(rawTexts(), [], '默认折叠时不向原生 Text 提交正文');
  await copy('请求正文');
  assert.equal(copied.at(-1), requestBody, '折叠时复制完整请求，不混入响应或元信息');
  await copy('响应正文');
  assert.equal(copied.at(-1), responseBody, '折叠时复制完整响应，不混入请求或元信息');

  await press(toggle('请求正文（原文）'));
  assert.equal(button(toggle('请求正文（原文）').parent, '上一页').props.disabled, true);
  const pages = [];
  for (;;) {
    const [page] = rawTexts();
    assert.ok(page.length > 0 && page.length <= 8192, '超长正文每次只展示有界文本');
    assert.ok(page.isWellFormed(), '页边界不能拆开 emoji 的代理对');
    pages.push(page);
    const next = button(toggle('请求正文（原文）').parent, '下一页');
    if (next.props.disabled) break;
    await press(next);
  }
  assert.ok(pages.length > 1);
  assert.equal(pages.join(''), requestBody, '逐页阅读应无缺失、重复、格式化或换行变化');
  await press(button(toggle('请求正文（原文）').parent, '上一页'));
  assert.equal(rawTexts()[0], pages.at(-2), '上一页返回相同原文');
  await copy('请求正文');
  assert.equal(copied.at(-1), requestBody, '翻页后仍复制完整正文');

  await press(toggle('响应正文（原文）'));
  assert.equal(rawTexts().length, 2, '请求与响应可独立展开');
  assert.ok(rawTexts().every(page => page.length <= 8192), '百万字符响应也不能整体提交原生排版');
  assert.ok(rawTexts().join('').length <= 16384, '同时展开时总展示量仍有界');
  copyFailure = true;
  await copy('响应正文');
  assert.match(texts(screen.root), /复制失败：剪贴板不可用/);
  copyFailure = false;
  await copy('响应正文');
  assert.equal(copied.at(-1), responseBody);
  assert.doesNotMatch(texts(screen.root), /复制失败/);
  assert.match(texts(screen.root), /已复制完整响应正文/);

  await act(async () => { screen.root.findByType(mocks['@shared/ui'].ModalSheet).props.onClose(); });
  await openRecord('large');
  assert.deepEqual(rawTexts(), [], '重开详情恢复折叠');
  await press(toggle('请求正文（原文）'));
  assert.equal(rawTexts()[0], pages[0], '重开详情从第一页阅读');
  await act(async () => { screen.root.findByType(mocks['@shared/ui'].ModalSheet).props.onClose(); });
  await openRecord('empty');
  await press(toggle('请求正文（原文）'));
  assert.match(texts(screen.root), /（空正文）/);
  assert.deepEqual(rawTexts(), []);
  await copy('请求正文');
  assert.equal(copied.at(-1), '', '空正文不应复制占位提示');
  await press(toggle('响应正文（原文）'));
  assert.deepEqual(rawTexts(), ['data: [DONE]\n'], '短正文完整展示且不附加分页内容');
  assert.equal(button(toggle('响应正文（原文）').parent, '下一页'), undefined);

  await act(async () => { screen.root.findByType(mocks['@shared/ui'].ModalSheet).props.onClose(); });
  await act(async () => { screen.root.findByType('ToggleField').props.onValueChange(false); });
  assert.equal(diagnosticsEnabled, false);
  assert.equal(snapshotReads, 2, '关闭记录只应由平台通知触发一次快照刷新');
  await openRecord('large');
  await copy('请求正文');
  assert.equal(copied.at(-1), requestBody, '关闭采集后仍可查看、复制已有记录');
  await act(async () => { screen.root.findByType(mocks['@shared/ui'].ModalSheet).props.onClose(); });
  await act(async () => { screen.root.findByType('ToggleField').props.onValueChange(true); });
  await act(async () => { await dialog.buttons.find(item => item.text === '开启记录').onPress(); });
  assert.equal(diagnosticsEnabled, true);
  assert.equal(snapshotReads, 3, '开启记录只应由平台通知触发一次快照刷新');
  await press(button(screen.root, '清空记录'));
  await act(async () => { await dialog.buttons.find(item => item.text === '清空').onPress(); });
  assert.equal(snapshotReads, 4, '清空记录只应由平台通知触发一次快照刷新');
  assert.equal(diagnosticsRecords.length, 0);
  console.log('通过：大正文有界阅读、原文逐页无损、独立全文复制、失败反馈、重开复位和操作后单次刷新。');
} finally {
  await act(async () => { screen?.unmount(); });
}
