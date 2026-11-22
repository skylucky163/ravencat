// 验证消息气泡排版契约：
// 1. Markdown 顶级 block 间距由 root.rowGap 统一承担，root 不得再使用负 margin 抵消末块底距；
// 2. 库默认带 marginBottom 的块级容器（paragraph / headingContainer / pre / htmlBlock /
//    blockquote / codeBlock / table）全部被显式归零，不会重新污染 Moon Kimi 主题；
// 3. 纯文本段落划分只把连续两个及以上换行当作段落分隔，单个换行保留为普通换行。
import { repoRoot } from '../../helpers/repo-root.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';


function loadTypeScriptModule(relativePath, requireModule = () => {
  throw new Error(`${relativePath} 不应产生运行时依赖`);
}) {
  const sourcePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(
    fs.readFileSync(sourcePath, 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
      fileName: sourcePath,
      reportDiagnostics: true,
    },
  );
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  const executeModule = new Function(
    'exports',
    'require',
    'module',
    '__filename',
    '__dirname',
    compiled.outputText,
  );
  executeModule(
    module.exports,
    requireModule,
    module,
    sourcePath,
    path.dirname(sourcePath),
  );
  return module.exports;
}

const themeVariants = loadTypeScriptModule('src/shared/theme/themeVariants.ts');

const noopComponent = () => null;

const bubbleContent = loadTypeScriptModule(
  'src/features/chat/presentation/messages/MessageBubble/MessageBubbleContent.tsx',
  (specifier) => {
    switch (specifier) {
      case 'react':
        return { memo: (component) => component };
      case 'react/jsx-runtime':
        return { jsx: noopComponent, jsxs: noopComponent, Fragment: 'Fragment' };
      case 'react-native':
        return {
          StyleSheet: { flatten: (style) => style, hairlineWidth: 1 },
          Text: noopComponent,
          View: noopComponent,
          TouchableOpacity: noopComponent,
        };
      case 'react-native-markdown-renderer':
        return { default: noopComponent, MarkdownIt: () => ({}) };
      case '@shopify/flash-list':
        return { useMappingHelper: () => ({ getMappingKey: (id) => id }) };
      case '@shared/theme':
        return themeVariants;
      case './AttachmentCard':
        return { default: noopComponent };
      case './styles':
        return { createMessageBubbleStyles: () => ({}) };
      case './selectableMarkdownRenderer':
        return { createSelectableMarkdownRenderer: () => () => null };
      default:
        throw new Error(`未预期的运行时依赖: ${specifier}`);
    }
  },
);

const {
  createMarkdownStylePreset,
  splitPlainTextParagraphs,
  MOON_KIMI_AI_PARAGRAPH_SPACING,
} = bubbleContent;

function createFakeTheme(id) {
  return {
    id,
    colors: {
      brand: { onPrimary: '#ffffff', primary: '#0000ff' },
      border: { default: '#cccccc' },
      surface: { muted: '#eeeeee' },
      text: { primary: '#000000', secondary: '#666666' },
      background: { screen: '#ffffff' },
    },
    spacing: { sm: 8 },
    radius: { sm: 4, md: 8 },
    effects: { glass: { enabled: false } },
  };
}

const fakeTextStyle = { fontSize: 15, lineHeight: 21, color: '#000000' };
const fakeBubbleStyles = {
  myText: fakeTextStyle,
  aiText: fakeTextStyle,
  reasoningText: fakeTextStyle,
  systemText: fakeTextStyle,
};

// 1. spacing ownership：root 用 rowGap 承担顶级 block 间距，且不再有负 margin 补偿。
const moonKimiPreset = createMarkdownStylePreset('ai', createFakeTheme('moon-kimi'), fakeBubbleStyles, false);
const defaultPreset = createMarkdownStylePreset('ai', createFakeTheme('default'), fakeBubbleStyles, false);

assert.equal(moonKimiPreset.root.rowGap, MOON_KIMI_AI_PARAGRAPH_SPACING, 'Moon Kimi 顶级 block 间距应由 root.rowGap 承担');
assert.equal(moonKimiPreset.root.marginBottom, 0, 'root 不得再使用负 margin 抵消末块底距');
assert.equal(defaultPreset.root.rowGap, 0, '其他主题的顶级 block 间距不应被 Moon Kimi 设计污染');
assert.equal(defaultPreset.root.marginBottom, 0);

// 2. 库默认带 marginBottom 的块级容器必须全部归零（两个主题都是），
//    否则浅合并会让默认尾距重新出现，最后一个 block 后面就会留空。
for (const [name, preset] of [['moonKimi', moonKimiPreset], ['default', defaultPreset]]) {
  for (const key of ['paragraph', 'headingContainer', 'list', 'pre', 'htmlBlock', 'blockquote', 'codeBlock', 'table']) {
    assert.equal(preset[key].marginBottom ?? 0, 0, `${name} 预设的 ${key} 不应保留尾距`);
  }
  assert.equal(preset.headingContainer.marginTop ?? 0, 0, `${name} 预设的 headingContainer 不应保留顶距`);
}

// 3. 纯文本段落划分：单换行是普通换行，连续两个及以上换行才是段落分隔。
assert.deepEqual(splitPlainTextParagraphs('第一行\n第二行\n第三行'), ['第一行\n第二行\n第三行'], '单换行不应被当作段落分隔');
assert.deepEqual(splitPlainTextParagraphs('第一段\n\n第二段'), ['第一段', '第二段']);
assert.deepEqual(splitPlainTextParagraphs('第一段\n\n\n\n第二段'), ['第一段', '第二段'], '更多连续换行仍只算一次段落分隔');
assert.deepEqual(splitPlainTextParagraphs('第一段\n\n'), ['第一段'], '结尾换行不应产生空段落');

console.log('Chat 消息气泡排版契约验证通过：root.rowGap 承担顶级间距、块级默认尾距全部归零、纯文本单换行不再被当作段落。');
