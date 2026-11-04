/** 验证思维链展开、原生文字选择、流式更新与回收后的状态隔离。 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const fromRepo = createRequire(path.join(root, 'package.json'));
const ts = fromRepo('typescript');
const React = fromRepo('react');
const { create: createRenderer, act } = fromRepo('react-test-renderer');
global.IS_REACT_ACT_ENVIRONMENT = true;
const frames = new Map();
let frameId = 0;
global.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
global.cancelAnimationFrame = id => frames.delete(id);
function load(file, mocks = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', output)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(mocks, name), `未声明依赖：${name}`);
    return mocks[name];
  });
  return module.exports;
}
// 渲染视觉边界使用占位组件，React 和 FlashList 的状态 Hook 使用真实实现。
let layouts = 0;
const recyclerContext = { layout: () => { layouts++; } };
const { useLayoutState } = load('node_modules/@shopify/flash-list/src/recyclerview/hooks/useLayoutState.ts', {
  react: React,
  '../RecyclerViewContextProvider': { useRecyclerViewContext: () => recyclerContext },
});
const { useRecyclingState } = load('node_modules/@shopify/flash-list/src/recyclerview/hooks/useRecyclingState.ts', {
  react: React, './useLayoutState': { useLayoutState },
});
const flash = { useRecyclingState };
const expansionState = load('src/features/chat/presentation/messages/components/reasoningExpansionState.ts', {
  react: React, '@shopify/flash-list': flash,
});
function create(element) {
  const expandedKeys = new Set();
  const wrap = (child) => React.createElement(expansionState.ReasoningExpansionContext.Provider, { value: expandedKeys }, child);
  const renderer = createRenderer(wrap(element));
  const update = renderer.update.bind(renderer);
  renderer.update = (child) => update(wrap(child));
  return renderer;
}
let theme = load('src/shared/theme/themes/defaultLight.ts').defaultLightTheme;
const themeApi = {
  ...load('src/shared/theme/themeVariants.ts'),
  useTheme: () => theme,
  isMoonKimiTheme: (value) => value.id === 'moon-kimi',
  isPaperNoteTheme: (value) => value.id === 'paper-note',
  GlassSurface: 'GlassSurface',
  useThemedStyles: (factory) => factory(theme),
};
const native = {
  View: 'View', Text: 'Text', TouchableOpacity: 'TouchableOpacity',
  StyleSheet: { create: (value) => value, hairlineWidth: 1 },
  Dimensions: { get: () => ({ height: 600 }) },
};
let finishFocusRelease;
const textSelection = { releaseTextSelectionFocus: () => finishFocusRelease ? new Promise((resolve) => {
  finishFocusRelease.resolve = resolve;
  if (finishFocusRelease.resolvers) finishFocusRelease.resolvers.push(resolve);
}) : Promise.resolve() };
const processCard = { __esModule: true, default: (props) => React.createElement('ProcessCard', props, props.expanded ? props.children : null) };
const styles = { createMessageBubbleStyles: () => ({}) };
const contents = {
  BubbleAttachmentList: 'Attachments', BubbleTextContent: 'Body', TranslationBlock: 'Translation',
  COMMON_PLAIN_TEXT_STYLE: {}, MOON_KIMI_AI_PARAGRAPH_SPACING: 1,
  createMarkdownStylePreset: () => ({}), getBubbleVariant: () => 'reasoning',
  shouldRenderMarkdownText: () => false, shouldUseWideMarkdownLayout: () => false,
};
const defaultStub = (name) => ({ __esModule: true, default: name });
const Bubble = load('src/features/chat/presentation/messages/MessageBubble/index.tsx', {
  '../../../appearance/presentation/useChatBubbleSkins': { useChatBubbleSkins: () => ({ user: null, ai: null }) },
  '../../../appearance/presentation/BubbleSkinDrawing': {},
  '../../../appearance/presentation/BubbleDecorationLayer': {},
  '../components/reasoningExpansionState': expansionState,
  '@platform/device': textSelection,
  react: React, 'react-native': native, '@shared/theme': themeApi, '@shopify/flash-list': flash,
  './styles': styles, './Avatar': { Avatar: 'Avatar' }, './ReplyQuote': { ReplyQuote: 'Quote' },
  './TokenInfo': { TokenInfo: 'TokenInfo' }, './ReasoningHeader': { ReasoningHeader: 'ReasoningHeader' },
  '../components/SharedChatRecordView': defaultStub('SharedChatRecord'),
  '../components/SharedMomentCard': defaultStub('SharedMoment'),
  './OfficialReplicaProcessCard': processCard, './PaperNoteMessageFrame': defaultStub('PaperFrame'),
  './StickerMessageCard': defaultStub('Sticker'), './VoiceMessageCard': defaultStub('Voice'),
  './layoutProbe': { isLayoutProbeEnabled: () => false }, './MessageBubbleContent': contents,
}).default;
const bubbleProps = (id) => ({ messageId: id, text: `思考 ${id}`, isMe: false, senderType: 'reasoning', onPreviewFile: () => {}, reasoningSurface: theme.id === 'moon-kimi' ? 'official-replica' : 'default' });
function header(renderer) { return renderer.root.findByType(theme.id === 'moon-kimi' ? 'ProcessCard' : 'ReasoningHeader'); }
function expanded(renderer) { const props = header(renderer).props; return props.expanded ?? props.isExpanded; }
async function verifyRepeatedToggle(toggle, isExpanded) {
  // 同一次渲染里的连续点击表达相同目标，不能相互反转。
  let first;
  let second;
  act(() => { first = toggle(); second = toggle(); });
  await act(async () => { await Promise.all([first, second]); });
  assert.equal(isExpanded(), true, '连续点展开仍应展开');
  finishFocusRelease = { resolvers: [] };
  act(() => { first = toggle(); second = toggle(); });
  assert.equal(isExpanded(), true, '释放原生选区前保留正文');
  await act(async () => {
    for (const resolve of finishFocusRelease.resolvers) resolve();
    await Promise.all([first, second]);
  });
  assert.equal(isExpanded(), false, '连续点收起不能又翻回展开');
  finishFocusRelease = null;
  await act(async () => toggle());
  finishFocusRelease = { resolvers: [] };
  act(() => { first = toggle(); second = toggle(); });
  await act(async () => { finishFocusRelease.resolvers[1](); await second; });
  assert.equal(isExpanded(), false);
  await act(async () => toggle());
  assert.equal(isExpanded(), true, '等待旧操作时仍能再次展开');
  await act(async () => { finishFocusRelease.resolvers[0](); await first; });
  assert.equal(isExpanded(), true, '迟到的旧收起不能覆盖后来点击展开的意图');
  finishFocusRelease = null;
  await act(async () => toggle());
}
for (const id of ['default-light', 'paper-note', 'moon-kimi']) {
  theme = { ...theme, id };
  let renderer;
  act(() => { renderer = create(React.createElement(Bubble, bubbleProps(101))); });
  assert.equal(expanded(renderer), false);
  await verifyRepeatedToggle(() => header(renderer).props.onToggle(), () => expanded(renderer));
  const previousLayouts = layouts;
  await act(async () => header(renderer).props.onToggle());
  assert.equal(expanded(renderer), true);
  assert.equal(renderer.root.findByType('Body').props.selectable, true, '各主题的思维链正文应启用原生选择');
  assert.ok(layouts > previousLayouts, '展开改变列表项高度时应通知列表重新布局');
  if (id === 'moon-kimi') {
    act(() => {
      header(renderer).props.onBodyLayout({ nativeEvent: { layout: { height: 100 } } });
      header(renderer).props.onContentSizeChange(200, 300);
    });
    assert.equal(header(renderer).props.scrollable, true);
  }
  act(() => renderer.update(React.createElement(Bubble, { ...bubbleProps(101), text: '同一条消息追加思考' })));
  assert.equal(expanded(renderer), true);
  if (id === 'moon-kimi') {
    assert.equal(header(renderer).props.scrollable, true, '同一消息更新正文时保留已测量尺寸');
  }
  act(() => renderer.update(React.createElement(Bubble, bubbleProps(102))));
  assert.equal(expanded(renderer), false, '回收实例换消息后不能继承上一条思维链的展开状态');
  await act(async () => header(renderer).props.onToggle());
  assert.equal(expanded(renderer), true);
  if (id === 'moon-kimi') {
    assert.equal(header(renderer).props.scrollable, false, '新消息不能继承上一条的滚动尺寸');
    act(() => header(renderer).props.onContentSizeChange(200, 300));
    assert.equal(header(renderer).props.scrollable, false, '新消息尚未测量视口时不能使用旧视口尺寸');
    act(() => header(renderer).props.onBodyLayout({ nativeEvent: { layout: { height: 100 } } }));
    assert.equal(header(renderer).props.scrollable, true);
  }
  act(() => renderer.update(React.createElement(Bubble, bubbleProps(101))));
  assert.equal(expanded(renderer), true, '回收回上一条消息时恢复它自己的展开意图');
  if (id === 'moon-kimi') {
    act(() => header(renderer).props.onBodyLayout({ nativeEvent: { layout: { height: 100 } } }));
    assert.equal(header(renderer).props.scrollable, false, '新消息尚未测量正文时不能使用旧正文尺寸');
  }
  act(() => renderer.update(null));
  act(() => renderer.update(React.createElement(Bubble, bubbleProps(101))));
  assert.equal(expanded(renderer), true, '卸载后重建的列表项也应保留当前会话的展开意图');
  act(() => renderer.unmount());
  let fresh;
  act(() => { fresh = create(React.createElement(Bubble, bubbleProps(101))); });
  assert.equal(expanded(fresh), false, '重新进入会话使用新的列表状态');
  act(() => fresh.unmount());
  console.log(`${id}: 思维链跨回收保留各自展开状态，新会话重置`);
}
theme = { ...theme, id: 'default-light' };
let independent;
act(() => { independent = create(React.createElement(React.Fragment, null, React.createElement(Bubble, { ...bubbleProps(201), key: 'a' }), React.createElement(Bubble, { ...bubbleProps(202), key: 'b' }))); });
await act(async () => independent.root.findAllByType('ReasoningHeader')[0].props.onToggle());
assert.deepEqual(independent.root.findAllByType('ReasoningHeader').map((node) => node.props.isExpanded), [true, false]);
await act(async () => independent.root.findAllByType('ReasoningHeader')[1].props.onToggle());
assert.deepEqual(independent.root.findAllByType('ReasoningHeader').map((node) => node.props.isExpanded), [true, true]);
await act(async () => independent.root.findAllByType('ReasoningHeader')[0].props.onToggle());
assert.deepEqual(independent.root.findAllByType('ReasoningHeader').map((node) => node.props.isExpanded), [false, true]);
act(() => independent.unmount());
console.log('同时挂载的不同气泡状态独立，没有直接共享展开状态');

const ActionGroup = load('src/features/chat/presentation/messages/MessageBubble/ActionGroupProcessCard.tsx', {
  '../components/reasoningExpansionState': expansionState,
  '@platform/device': textSelection,
  react: React, 'react-native': native, '@expo/vector-icons': { Ionicons: 'Icon' },
  '@shopify/flash-list': { ...flash, useMappingHelper: () => ({ getMappingKey: (key) => key }) },
  '@features/chat/messages/domain': {
    parseMessageMetadata: (message) => JSON.parse(message.metadataJson),
    isToolStatusMessageMetadata: (metadata) => metadata.type === 'toolStatus',
  },
  '@features/chat/messages/application/AgentTransientTimeline': { getAgentTimelineRenderKey: (message) => String(message.id) },
  '@shared/theme': { ...themeApi, getChatInteractionProfile: (value) => ({ reasoningSurface: value.id === 'moon-kimi' ? 'official-replica' : 'default', toolStatusSurface: value.id === 'moon-kimi' ? 'official-replica' : 'default' }) },
  './styles': styles, './OfficialReplicaProcessCard': processCard, './MessageBubbleContent': contents,
}).default;
for (const id of ['default-light', 'paper-note', 'moon-kimi']) {
  theme = { ...theme, id };
  const children = ['已调用：打开朋友圈', '已调用：读取动态', '已调用：点赞'].map((displayText, index) => ({ id: index + 1, senderType: 'system', text: displayText, metadataJson: JSON.stringify({ type: 'toolStatus', status: 'completed', displayText }) }));
  const group = { key: 'tools-only', children, isRunning: false };
  let renderer;
  act(() => { renderer = create(React.createElement(ActionGroup, { group })); });
  const actionHeader = () => renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity');
  await verifyRepeatedToggle(
    () => actionHeader().props[id === 'moon-kimi' ? 'onToggle' : 'onPress'](),
    () => id === 'moon-kimi' ? actionHeader().props.expanded : renderer.root.findAllByType('Text').some((node) => String(node.props.children).startsWith('已调用：')),
  );
  await act(async () => renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity').props[id === 'moon-kimi' ? 'onToggle' : 'onPress']());
  assert.equal(renderer.root.findAllByType('Body').length, 0, '纯工具步骤不得生成思维链占位');
  const texts = renderer.root.findAllByType('Text').map((node) => node.props.children);
  assert.deepEqual(texts.filter((text) => String(text).startsWith('已调用：')), children.map((child) => child.text), '无思维链的模型仍应完整按顺序展示每个工具步骤');
  const reasoning = { id: 4, senderType: 'reasoning', text: '真实思考内容', metadataJson: '{}' };
  act(() => renderer.update(React.createElement(ActionGroup, { group: { ...group, children: [reasoning, ...children] } })));
  assert.deepEqual(renderer.root.findAllByType('Body').map((node) => node.props.text), ['真实思考内容'], '修复纯工具步骤后，真实思维链仍须完整显示');
  const secondReasoning = { ...reasoning, id: 5, text: '**第二段**\n思考内容' };
  const activity = { id: 6, senderType: 'system', text: '等待 AI 响应…', metadataJson: JSON.stringify({ type: 'agentActivity', phase: 'started' }) };
  act(() => renderer.update(React.createElement(ActionGroup, { group: { ...group, children: [activity, reasoning, ...children, secondReasoning] } })));
  assert.deepEqual(renderer.root.findAllByType('Body').map((node) => node.props.selectable), [false, true, true], '行动步骤仅思考正文启用原生选择');
  finishFocusRelease = {};
  let collapse;
  act(() => { collapse = renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity').props[id === 'moon-kimi' ? 'onToggle' : 'onPress'](); });
  assert.equal(renderer.root.findAllByType('Body').length, 3, '原生选区释放之前正文不能卸载');
  await act(async () => { finishFocusRelease.resolve(); await collapse; });
  assert.equal(renderer.root.findAllByType('Body').length, 0, '释放后折叠正文');
  finishFocusRelease = null;
  await act(async () => renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity').props[id === 'moon-kimi' ? 'onToggle' : 'onPress']());
  finishFocusRelease = {};
  act(() => { collapse = renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity').props[id === 'moon-kimi' ? 'onToggle' : 'onPress'](); });
  act(() => renderer.update(React.createElement(ActionGroup, { group: { ...group, key: 'recycled-group', children: [activity, reasoning, ...children, secondReasoning] } })));
  await act(async () => renderer.root.findByType(id === 'moon-kimi' ? 'ProcessCard' : 'TouchableOpacity').props[id === 'moon-kimi' ? 'onToggle' : 'onPress']());
  await act(async () => { finishFocusRelease.resolve(); await collapse; });
  assert.equal(renderer.root.findAllByType('Body').length, 3, '旧选区释放完成不能折叠回收后正在阅读的新行动步骤');
  finishFocusRelease = null;
  act(() => renderer.update(React.createElement(ActionGroup, { group: { ...group, children: [reasoning] } })));
  assert.deepEqual(renderer.root.findAllByType('Body').map((node) => node.props.text), ['真实思考内容'], '回收回原行动步骤时恢复其展开意图');
  act(() => renderer.update(null));
  act(() => renderer.update(React.createElement(ActionGroup, { group: { ...group, children: [reasoning] } })));
  assert.equal(renderer.root.findAllByType('Body').length, 1, '行动步骤重新挂载后仍保留展开');
  act(() => renderer.unmount());
}

// Markdown 使用真实解析与渲染，只有 React Native 原生节点由占位组件承接。
const markdownRoot = path.join(root, 'node_modules/react-native-markdown-renderer/lib/commonjs');
const markdownCache = new Map();
function loadMarkdown(file = path.join(markdownRoot, 'index.js')) {
  if (markdownCache.has(file)) return markdownCache.get(file).exports;
  const module = { exports: {} };
  markdownCache.set(file, module);
  new Function('module', 'exports', 'require', fs.readFileSync(file, 'utf8'))(module, module.exports, (name) => {
    if (name === 'react-native') return { ...native, Platform: { select: (options) => options.android }, Image: 'Image', TouchableWithoutFeedback: 'TouchableWithoutFeedback' };
    if (name.startsWith('.')) return loadMarkdown(path.resolve(path.dirname(file), `${name}.js`));
    return fromRepo(name);
  });
  return module.exports;
}
const markdownLibrary = loadMarkdown();
const selectableMarkdown = load('src/features/chat/presentation/messages/MessageBubble/selectableMarkdownRenderer.tsx', {
  react: React, 'react-native': native, 'react-native-markdown-renderer': markdownLibrary,
});
const { BubbleTextContent } = load('src/features/chat/presentation/messages/MessageBubble/MessageBubbleContent.tsx', {
  react: React, 'react-native': native, '@shared/theme': themeApi,
  'react-native-markdown-renderer': markdownLibrary,
  './selectableMarkdownRenderer': selectableMarkdown,
  '@shopify/flash-list': { useMappingHelper: () => ({ getMappingKey: (key) => key }) },
  './AttachmentCard': defaultStub('Attachment'), './styles': styles,
});
const textProps = { hasTextContent: true, plainTextStyle: {}, markdownStyles: { text: { fontSize: 12 }, strong: { fontWeight: '700' }, heading1: { fontSize: 18 } }, selectable: true };
let textRenderer;
act(() => { textRenderer = create(React.createElement(BubbleTextContent, { ...textProps, text: '第一段\n\n第二段', paragraphSpacing: 24, shouldUseMarkdown: false })); });
assert.ok(textRenderer.root.findAllByType('Text').some((node) => node.props.selectable && node.props.children === '第一段\n\n第二段'), '多段纯文本必须位于同一原生选区');
act(() => textRenderer.update(React.createElement(BubbleTextContent, { ...textProps, text: '完整纯文本', shouldUseMarkdown: false })));
assert.equal(textRenderer.root.findByType('Text').props.selectable, true);
act(() => textRenderer.update(React.createElement(BubbleTextContent, { ...textProps, text: '完整纯文本', selectable: false, shouldUseMarkdown: false })));
assert.equal(textRenderer.root.findByType('Text').props.selectable, false, '普通正文不改变现有长按行为');
const markdownText = '# 标题\n\n含 **加粗** 与 [链接](https://example.com) 的段落\n\n- 第一项\n- 第二项\n  - 子项\n\n3. 第三项\n4. 第四项\n\n> 引用内容\n\n```ts\nconst value = 1;\n```\n\n    缩进代码\n\n| 表头甲 | 表头乙 |\n| --- | --- |\n| 内容甲 | 内容乙 |';
act(() => textRenderer.update(React.createElement(BubbleTextContent, { ...textProps, text: markdownText, shouldUseMarkdown: true })));
const selectableTexts = textRenderer.root.findAllByType('Text').filter((node) => node.props.selectable);
function renderedText(node) {
  return typeof node === 'string' ? node : node.children.map(renderedText).join('');
}
const expectedContent = ['标题', '加粗', '链接', '• 第一项\n• 第二项', '  • 子项', '3. 第三项\n4. 第四项', '引用内容', 'const value = 1;', '缩进代码', '表头甲 | 表头乙\n内容甲 | 内容乙'];
assert.ok(selectableTexts.some((node) => expectedContent.every((content) => renderedText(node).includes(content))), '标题、多个列点、段落、代码和表格内容必须处于同一原生选区，不能仅逐块可选');
assert.ok(selectableTexts.every((node) => node.findAllByType('View').length === 0), '原生文字选区内部不能被块级布局容器切断');
assert.ok(textRenderer.root.findAllByType('Text').some((node) => node.props.style?.fontSize === 18), '连续选择仍保留标题字号');
assert.ok(textRenderer.root.findAllByType('Text').some((node) => node.props.style?.fontWeight === '700'), '连续选择仍保留加粗格式');
assert.ok(textRenderer.root.findAllByType('Text').some((node) => node.props.onPress), '原生选择不移除链接点击行为');
act(() => textRenderer.update(React.createElement(BubbleTextContent, { ...textProps, text: markdownText, selectable: false, shouldUseMarkdown: true })));
assert.equal(textRenderer.root.findAllByType('Text').filter((node) => node.props.selectable).length, 0, '普通 Markdown 不启用思维链的选择策略');
act(() => textRenderer.unmount());

const { TouchableMessageBubble } = load('src/features/chat/presentation/messages/components/ChatMessageListParts.tsx', {
  react: React, 'react-native': { ...native, TouchableWithoutFeedback: 'TouchableWithoutFeedback' },
  'lucide-react-native': { Check: 'Check', Circle: 'Circle' },
  '../MessageBubble': defaultStub('MessageBubble'), '../MessageBubble/ActionGroupProcessCard': defaultStub('ActionGroup'),
  '../MessageBubble/layoutProbe': { isLayoutProbeEnabled: () => false },
  './TogetherListeningActivityCard': defaultStub('TogetherListeningCard'), './ChatMessageInlineActions': defaultStub('InlineActions'),
  '../../../messages/domain/chatMessageMetadata': { getMessageSharedRecord: () => null, getMessageSharedMoment: () => null, parseMessageMetadata: () => null },
  './chatMessageRenderUtils': {}, './chatActionGrouping': {}, './chatStyles': { createMessageListPartsStyles: () => ({}) },
  './togetherListeningCardViewModel': {},
  '@shared/theme': { ...themeApi, getChatInteractionProfile: (value) => ({
    enableMessageLongPressMenu: true, reasoningSurface: value.id === 'moon-kimi' ? 'official-replica' : 'default',
  }) },
});
for (const id of ['default-light', 'paper-note', 'moon-kimi']) {
  theme = { ...theme, id };
  const props = { msg: { id: 1, senderType: 'reasoning', text: '思考内容', isMe: false, status: 'sent' }, resolvedAIIdentity: {}, onMessageLongPress: () => {} };
  let touchRenderer;
  act(() => { touchRenderer = create(React.createElement(TouchableMessageBubble, props)); });
  assert.equal(touchRenderer.root.findAll((node) => typeof node.props.onLongPress === 'function').length, 0, '所有主题的思维链外层均不能抢占原生长按');
  act(() => touchRenderer.unmount());
  act(() => { touchRenderer = create(React.createElement(TouchableMessageBubble, { ...props, msg: { ...props.msg, senderType: 'assistant' } })); });
  assert.equal(touchRenderer.root.findAllByType('TouchableWithoutFeedback').length, 1, '普通消息继续支持已有操作菜单');
  act(() => touchRenderer.unmount());
}
console.log('Chat reasoning state verification passed.');
