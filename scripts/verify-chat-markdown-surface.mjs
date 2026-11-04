// 验证消息气泡 Markdown 表面契约（真实 createMarkdownStylePreset 行为测试）：
// 1. DIY 背景（customBackground=true）：不留下任何自绘实底，代码/正文/列表标号只跟随该侧正文色；
// 2. 普通主题（customBackground=false 或不传）：现有主题展示语义不变，不新增列表标号颜色；
// 3. 语义样式（等宽、粗体、斜体、链接、表格结构）在两种模式下都保留。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromRepo = createRequire(path.join(repoRoot, 'package.json'));
const React = fromRepo('react');

// 渲染库的 renderRules 只消费自己的 style key：key 名字写错会静默落回库默认（浅色实底/标号默认黑）。
// 这里加载真实渲染库的规则函数，确认预设真的作用到了渲染出的 Text 上。
const reactNativeStub = {
  Platform: { OS: 'android', select: (values) => values.android ?? values.default },
  StyleSheet: { create: (value) => value, hairlineWidth: 1 },
  Text: 'Text',
  View: 'View',
  Image: 'Image',
  TouchableWithoutFeedback: 'TouchableWithoutFeedback',
  Linking: { openURL: async () => {} },
};
const loadModule = Module._load;
Module._load = function (request, ...rest) {
  return request === 'react-native' ? reactNativeStub : loadModule.call(this, request, ...rest);
};
const rendererRules = fromRepo('react-native-markdown-renderer').renderRules;
// 渲染库在加载期就取完 react-native 依赖，之后恢复真实解析，避免影响后续模块。
Module._load = loadModule;

function loadTypeScriptModule(relativePath, requireModule = (specifier) => {
  throw new Error(`${relativePath} 不应产生运行时依赖: ${specifier}`);
}) {
  const sourcePath = path.join(repoRoot, relativePath);
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${relativePath} 无法编译`);

  const module = { exports: {} };
  new Function('exports', 'require', 'module', '__filename', '__dirname', compiled.outputText)(
    module.exports,
    requireModule,
    module,
    sourcePath,
    path.dirname(sourcePath),
  );
  return module.exports;
}

const noopComponent = () => null;
const themeVariants = loadTypeScriptModule('src/shared/theme/themeVariants.ts');
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
        return { default: noopComponent, MarkdownIt: () => ({}), hasParents: () => false };
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

const { createMarkdownStylePreset } = bubbleContent;
const daylight = loadTypeScriptModule('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const night = loadTypeScriptModule('src/shared/theme/themes/defaultDark.ts').defaultDarkTheme;

/** 与 textStyles.ts 里 default 主题变体一致：两侧正文色由主题决定，Markdown 只应跟随。 */
function createBubbleStyles(theme, textColorOverride) {
  return {
    myText: {
      color: textColorOverride?.me ?? theme.colors.chat.userText,
      fontSize: 15,
      lineHeight: 21,
    },
    aiText: {
      color: textColorOverride?.ai ?? theme.colors.chat.aiText,
      fontSize: 15,
      lineHeight: 21,
    },
    reasoningText: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 17 },
    systemText: { color: theme.colors.text.secondary, fontSize: 12, lineHeight: 18 },
  };
}

/** 渲染库 renderRules 真正消费的文字样式 key（列表标号是独立的 Text 样式）。 */
const TEXT_STYLE_KEYS = [
  'text',
  'paragraph',
  'strong',
  'em',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'link',
  'blockquote',
  'codeInline',
  'codeBlock',
  'listUnorderedItemText',
  'listOrderedItemText',
  'listUnorderedItemIcon',
  'listOrderedItemIcon',
  'strikethrough',
  'u',
];

const themes = [['daylight', daylight], ['night', night]];
const sides = [['me', 'me'], ['ai', 'ai']];

// 0. 渲染契约：预设的 key 必须真的被渲染库消费，而不是名字看起来对。
const diyUser = createMarkdownStylePreset('me', night, createBubbleStyles(night), false, true);
for (const key of ['strikethrough', 'u', 'listUnorderedItemIcon', 'listOrderedItemIcon']) {
  assert.ok(diyUser[key], `DIY 预设必须给出 ${key}，否则渲染库会落回默认黑`);
}
const orderedItem = rendererRules.list_item(
  { key: 'ordered', index: 0, markup: '.' },
  [],
  [{ type: 'ordered_list' }],
  diyUser,
);
const orderedMarker = React.Children.toArray(orderedItem.props.children)[0];
assert.equal(
  orderedMarker.props.style,
  diyUser.listOrderedItemIcon,
  '有序列表标号必须消费预设的 listOrderedItemIcon',
);
assert.equal(orderedMarker.props.style.color, night.colors.chat.userText, '序号文字必须使用该侧正文色');

const unorderedItem = rendererRules.list_item(
  { key: 'bullet', index: 0, markup: '-' },
  [],
  [{ type: 'bullet_list' }],
  diyUser,
);
const unorderedMarker = React.Children.toArray(unorderedItem.props.children)[0];
assert.equal(unorderedMarker.props.style, diyUser.listUnorderedItemIcon, '项目符号必须消费预设的 listUnorderedItemIcon');

const inlineCode = rendererRules.code_inline({ key: 'code', content: 'get_page' }, [], [], diyUser);
assert.equal(inlineCode.props.style, diyUser.codeInline, '行内代码必须消费预设的 codeInline');
assert.equal(inlineCode.props.style.backgroundColor, 'transparent', '行内代码不得在 DIY 背景上铺实底');
assert.equal(
  rendererRules.fence({ key: 'fence', content: 'x' }, [], [], diyUser).props.style,
  diyUser.codeBlock,
  '代码块必须消费预设的 codeBlock',
);

// 1. DIY 背景：任何 key 都不得留下自绘实底（hr 是分隔线，不是底色块）。
for (const [themeName, theme] of themes) {
  for (const [sideName, variant] of sides) {
    const bubbleStyles = createBubbleStyles(theme);
    const preset = createMarkdownStylePreset(variant, theme, bubbleStyles, false, true);
    const label = `${themeName}/${sideName}/DIY`;
    const sideTextColor = sideName === 'me' ? theme.colors.chat.userText : theme.colors.chat.aiText;

    const solidFills = Object.entries(preset)
      .filter(([key, style]) => key !== 'hr' && style && style.backgroundColor
        && style.backgroundColor !== 'transparent')
      .map(([key]) => key);
    assert.deepEqual(solidFills, [], `${label} 不得保留盖住 PNG 的实底`);

    for (const key of TEXT_STYLE_KEYS) {
      assert.equal(preset[key]?.color, sideTextColor, `${label} 的 ${key} 必须跟随该侧正文色`);
    }

    // 分隔线跟随可读正文色，不再为 PNG 假设主题边框的对比度。
    assert.equal(preset.hr.backgroundColor, sideTextColor, `${label} 分隔线跟随可读正文色`);
    assert.notEqual(preset.table.borderColor, theme.colors.border.default, `${label} 表格线不应沿用主题边框色`);
    assert.equal(preset.table.borderColor, preset.tableHeaderCell.borderColor, `${label} 表格线颜色应统一`);
    assert.ok(preset.table.borderWidth > 0, `${label} 表格结构应保留`);
    assert.ok(preset.tableHeaderCell.borderWidth > 0, `${label} 单元格结构应保留`);
  }
}

// 2. DIY 背景下的自定义正文色：颜色必须来自气泡，而不是主题。
for (const [themeName, theme] of themes) {
  const custom = { me: '#FFD400', ai: '#00E5FF' };
  const bubbleStyles = createBubbleStyles(theme, custom);
  for (const [sideName, variant] of sides) {
    const preset = createMarkdownStylePreset(variant, theme, bubbleStyles, false, true);
    const expected = custom[sideName];
    assert.equal(preset.codeInline.color, expected, `${themeName}/${sideName} 行内代码应跟随自定义正文色`);
    assert.equal(preset.codeBlock.color, expected, `${themeName}/${sideName} 代码块应跟随自定义正文色`);
    assert.equal(preset.listOrderedItemIcon.color, expected, `${themeName}/${sideName} 序号应跟随自定义正文色`);
    assert.equal(preset.listUnorderedItemIcon.color, expected, `${themeName}/${sideName} 项目符号应跟随自定义正文色`);
    // 列表标号只是补颜色，库原有的边距/行高必须保留，否则会挤在文字上。
    assert.equal(preset.listOrderedItemIcon.marginLeft, 10, `${themeName}/${sideName} 序号左边距应保留库默认`);
    assert.equal(preset.listOrderedItemIcon.marginRight, 10, `${themeName}/${sideName} 序号右边距应保留库默认`);
    assert.equal(preset.listOrderedItemIcon.lineHeight, 24, `${themeName}/${sideName} 序号行高应保留库默认`);
  }
}

// 3. 语义保留：等宽/粗体/斜体/链接/表格结构在两个模式都不变。
for (const customBackground of [false, true]) {
  for (const [themeName, theme] of themes) {
    for (const [sideName, variant] of sides) {
      const preset = createMarkdownStylePreset(variant, theme, createBubbleStyles(theme), false, customBackground);
      const label = `${themeName}/${sideName}/custom=${customBackground}`;
      assert.equal(preset.codeInline.fontFamily, 'monospace', `${label} 行内代码应保持等宽`);
      assert.equal(preset.codeBlock.fontFamily, 'monospace', `${label} 代码块应保持等宽`);
      assert.equal(preset.strong.fontWeight, '700', `${label} 粗体语义应保留`);
      assert.equal(preset.em.fontStyle, 'italic', `${label} 斜体语义应保留`);
      assert.equal(preset.link.textDecorationLine, 'underline', `${label} 链接下划线语义应保留`);
      assert.ok(preset.table.borderWidth > 0, `${label} 表格边框语义应保留`);
    }
  }
}

// 4. 普通主题未被重写：不传第五个参数与显式 false 完全一致，且仍是各主题原有取值。
for (const [themeName, theme] of themes) {
  for (const [sideName, variant] of sides) {
    const bubbleStyles = createBubbleStyles(theme);
    const legacy = createMarkdownStylePreset(variant, theme, bubbleStyles, false);
    assert.deepEqual(
      legacy,
      createMarkdownStylePreset(variant, theme, bubbleStyles, false, false),
      `${themeName}/${sideName} 默认参数必须保持旧行为`,
    );

    const usesUserBubbleColors = sideName === 'me';
    const label = `${themeName}/${sideName}/主题`;
    assert.equal(
      legacy.codeInline.backgroundColor,
      usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.surface.muted,
      `${label} 行内代码底色不应被改动`,
    );
    assert.equal(
      legacy.codeBlock.backgroundColor,
      usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.background.screen,
      `${label} 代码块底色不应被改动`,
    );
    assert.equal(legacy.codeBlock.color, theme.colors.text.primary, `${label} 代码块文字色不应被改动`);
    assert.equal(legacy.tableHeader.backgroundColor, theme.colors.surface.muted, `${label} 表头底色不应被改动`);
    assert.equal(legacy.table.borderColor, theme.colors.border.default, `${label} 表格线不应被改动`);
    assert.equal(legacy.hr.backgroundColor, theme.colors.border.default, `${label} 分隔线不应被改动`);
    assert.equal(
      legacy.link.color,
      usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.brand.primary,
      `${label} 链接色不应被改动`,
    );
    assert.equal(
      legacy.blockquote.color,
      usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.text.secondary,
      `${label} 引用色不应被改动`,
    );
    // 普通主题没有列表标号颜色 key：库默认行为保持原样。
    assert.equal('listOrderedItemIcon' in legacy, false, `${label} 不应给普通主题新增列表标号样式`);
    assert.equal('listUnorderedItemIcon' in legacy, false, `${label} 不应给普通主题新增项目符号样式`);
  }
}

// 5. 宽度布局参数仍然生效（前四项签名兼容）。
const wide = createMarkdownStylePreset('ai', daylight, createBubbleStyles(daylight), true);
assert.equal(wide.root.width, '100%', '宽布局应继续占满宽度');
assert.equal(wide.paragraph.width, '100%', '宽布局段落应继续占满宽度');

console.log(
  'Chat Markdown 表面契约验证通过：DIY 背景无自绘实底且字色跟随该侧正文色，'
  + '普通主题保持原展示语义，代码/列表/表格语义在两种模式下都保留。',
);
