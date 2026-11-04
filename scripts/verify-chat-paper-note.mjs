import { sharedMoment } from './helpers/chat-sharing-fixture.mjs';
/** 纸条主题的消息布局回归；媒体与原生渲染边界使用占位，布局组件和 React 使用真实实现。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { act, create } from 'react-test-renderer';
import ts from 'typescript';
import './verify-chat-footer.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const root = path.resolve(import.meta.dirname, '..');
function load(file, dependencies = {}) {
  const output = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React, esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('module', 'exports', 'require', output)(module, module.exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `未声明依赖：${name}`);
    return dependencies[name];
  });
  return module.exports;
}

const flatten = (value) => Object.assign({}, ...[value].flat(Infinity).filter(Boolean));
const native = {
  View: 'View', Text: 'Text', Image: 'Image', TouchableOpacity: 'TouchableOpacity', Pressable: 'Pressable',
  Dimensions: { get: () => ({ width: 400, height: 800 }) },
  StyleSheet: { create: (value) => value, flatten, hairlineWidth: 1, absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } },
};
const variants = load('src/shared/theme/themeVariants.ts');
const metadata = load('src/features/chat/messages/domain/chatMessageMetadata.ts', {
  './SharedMoment': sharedMoment, './SharedChatRecord': {}, './ChatSticker': load('src/features/chat/messages/domain/ChatSticker.ts'),
});
const presentation = load('src/features/chat/presentation/messages/components/chatMessagePresentation.ts', {
  '@features/chat/messages/domain': metadata,
});
const themes = ['defaultLight', 'defaultDark', 'liquidGlass', 'moonKimi', 'paperNote'].map((name) =>
  load(`src/shared/theme/themes/${name}.ts`)[`${name}Theme`]);
let theme = themes.at(-1);
const themeContext = React.createContext(null);
const themeApi = {
  ...variants, useTheme: () => React.useContext(themeContext),
  useThemedStyles: (factory) => factory(React.useContext(themeContext)),
  ThemedSurface: 'Surface', GlassSurface: 'GlassSurface',
};
const bubbleDir = 'src/features/chat/presentation/messages/MessageBubble/';
let layoutNotifications = 0;
const recycling = load('node_modules/@shopify/flash-list/src/recyclerview/hooks/useRecyclingState.ts', {
  react: React, './useLayoutState': { useLayoutState: initial => {
    const [value, setValue] = React.useState(initial);
    const update = React.useCallback(next => { layoutNotifications++; setValue(next); }, []);
    return [value, update];
  } },
});
const expansion = load('src/features/chat/presentation/messages/components/reasoningExpansionState.ts', {
  react: React, '@shopify/flash-list': recycling,
});
const base = { react: React, 'react-native': native, '@shared/theme': themeApi };
const styles = load(`${bubbleDir}styles.ts`, {
  ...base,
  './textStyles': load(`${bubbleDir}textStyles.ts`, base),
  './paperNoteStyles': load(`${bubbleDir}paperNoteStyles.ts`, base),
  './supplementStyles': load(`${bubbleDir}supplementStyles.ts`, base),
});
const frame = load(`${bubbleDir}PaperNoteMessageFrame.tsx`, { ...base, './styles': styles });
const stub = (name) => ({ __esModule: true, default: name });
const quote = load(`${bubbleDir}ReplyQuote.tsx`, {
  ...base, './styles': styles, './AttachmentCard': stub('Attachment'),
  '../components/SharedMomentCard': stub('Moment'),
  './StickerMessageCard': stub('Sticker'), './VoiceMessageCard': stub('Voice'),
});
const contents = load(`${bubbleDir}MessageBubbleContent.tsx`, {
  './selectableMarkdownRenderer': { createSelectableMarkdownRenderer: () => () => null },
  ...base, './styles': styles, './AttachmentCard': stub('Attachment'),
  '@shopify/flash-list': { useMappingHelper: () => ({ getMappingKey: (id) => id }) },
  'react-native-markdown-renderer': { __esModule: true, default: 'Markdown', MarkdownIt: () => ({}), hasParents: () => false },
});
let skinSnapshot = { user: null, ai: null };
const skinDrawing = load('src/features/chat/appearance/presentation/BubbleSkinDrawing.tsx', {
  react: React,
  '@platform/device/MessageBubbleBackground': { MessageBubbleBackground: 'SkinBackground' },
  '../application/ChatBubbleSkinRuntime': { reportBubbleSkinLoadError: () => {} },
});
const decorations = load('src/features/chat/appearance/presentation/BubbleDecorationLayer.tsx', {
  ...base, 'react-native-gesture-handler': {},
  '../application/ChatBubbleSkinRuntime': { reportBubbleSkinLoadError: () => {} },
});
const Bubble = load(`${bubbleDir}index.tsx`, {
  '../../../appearance/presentation/BubbleDecorationLayer': decorations,
  '../../../appearance/presentation/useChatBubbleSkins': { useChatBubbleSkins: () => skinSnapshot },
  '../../../appearance/presentation/BubbleSkinDrawing': skinDrawing,
  '../components/reasoningExpansionState': expansion,
  '@platform/device': { releaseTextSelectionFocus: async () => {} },
  ...base, './styles': styles, './PaperNoteMessageFrame': frame, './ReplyQuote': quote,
  './MessageBubbleContent': contents, './Avatar': { Avatar: 'Avatar' },
  './TokenInfo': { TokenInfo: () => null }, './ReasoningHeader': { ReasoningHeader: 'Reasoning' },
  './OfficialReplicaProcessCard': stub('Process'), './StickerMessageCard': stub('Sticker'),
  './VoiceMessageCard': stub('Voice'), '../components/SharedMomentCard': stub('Moment'),
  '../components/SharedChatRecordView': stub('SharedRecord'),
  './layoutProbe': { isLayoutProbeEnabled: () => false },
  '@shopify/flash-list': recycling,
}).default;
const Card = load('src/features/chat/presentation/messages/components/TogetherListeningActivityCard.tsx', {
  ...base, '@shared/ui': { showAppDialog: () => {} }, 'lucide-react-native': { Headphones: 'Headphones' },
  '../MessageBubble/Avatar': { Avatar: 'Avatar' }, '../MessageBubble/PaperNoteMessageFrame': frame,
}).default;
function render(Component, props) {
  let renderer;
  act(() => { renderer = create(themedElement(Component, props), { createNodeMock: nativeNode }); });
  return renderer;
}
let nativeBubbleBounds = { width: 240, height: 120 };
const nativeNode = () => ({ measure: callback => callback(0, 0, nativeBubbleBounds.width, nativeBubbleBounds.height, 0, 0) });
const themedElement = (Component, props) => React.createElement(
  expansion.ReasoningExpansionContext.Provider, { value: new Set() },
  React.createElement(themeContext.Provider, { value: theme }, React.createElement(Component, props)));
const text = (renderer, content) => renderer.root.findAllByType('Text').find((node) =>
  [node.props.children].flat().join('') === content);
const viewStyle = (node) => flatten(node.parent.props.style);

// 同一步的文字、语音与表情共用逻辑编号；隐藏思考和合并文字都不能吞掉媒体。
for (theme of themes) {
  const profile = variants.getChatInteractionProfile(theme);
  const message = (id, text, extra = {}) => ({
    id, text, senderType: 'assistant', isMe: false, logicalMessageId: 'step-1',
    segmentIndex: 0, segmentTotal: 1, status: 'sent', ...extra,
  });
  const voice = message(3, '思考正文', { metadataJson: JSON.stringify({ kind: 'voice', voice: {
    schemaVersion: 1, mediaAssetId: 'voice-1', mimeType: 'audio/mpeg', durationMs: 2000,
    transcriptSource: 'assistant_source_text',
  } }) });
  const sticker = message(4, '', { metadataJson: JSON.stringify({ kind: 'sticker', sticker: {
    stickerId: 's1', mediaAssetId: 'sticker-1', name: '开心', description: null, tags: [],
    emotion: null, mimeType: 'image/png', width: null, height: null, isAnimated: false,
  } }) });
  const reasoning = message(0, '思考正文', { senderType: 'reasoning' });
  const input = [reasoning, message(1, '第一段', { segmentTotal: 2 }),
    message(2, '第二段', { segmentIndex: 1, segmentTotal: 2 }), voice, sticker];
  const visible = presentation.collapseAssistantSegmentsForPresentation(input, profile);
  assert.ok(visible.includes(voice), `${theme.id} 必须保留独立语音及其元数据`);
  assert.ok(visible.includes(sticker), `${theme.id} 必须保留独立表情`);
  assert.deepEqual(visible.filter(item => item.id === 1 || item.id === 2).map(item => item.text),
    profile.enableAssistantMessageSegmentation ? ['第一段', '第二段'] : ['第一段\n\n第二段']);
  const renderer = render(Bubble, {
    messageId: voice.id, text: voice.text, senderType: voice.senderType, isMe: false,
    voice: metadata.getMessageVoice(voice), onPreviewFile: () => {},
  });
  assert.equal(renderer.root.findAllByType('Voice').length, 1);
  act(() => renderer.unmount());
}

// 引用、译文与正文共用左侧起点；其他主题仍保留用户右侧对齐。
for (theme of themes) {
  const renderer = render(Bubble, {
    messageId: 1, text: '用户正文', isMe: true, senderType: 'user', userName: '枫渡',
    replyToText: '被引用的文字', translation: { text: '译文', sourceLabel: '模型' }, onPreviewFile: () => {},
  });
  const alignment = theme.id === 'paper-note' ? 'flex-start' : 'flex-end';
  assert.equal(viewStyle(text(renderer, '被引用的文字')).alignSelf, alignment, `${theme.id} 引用对齐`);
  assert.equal(viewStyle(text(renderer, '译文')).alignSelf, alignment, `${theme.id} 译文对齐`);
  if (theme.id === 'paper-note') {
    assert.ok(text(renderer, '枫渡：'));
    assert.equal(renderer.root.findAllByType('Avatar').length, 0);
  }
  act(() => renderer.unmount());
}

// 通话、语音、表情、图片和文件均在纸条姓名下展示；分享卡片有独立表面。
theme = themes.at(-1);
for (const [kind, extra, expected] of [
  ['通话', { text: '通话已结束 01:23' }, 'Text'],
  ['语音', { voice: { mediaAssetId: 'voice-1', durationMs: 2000 }, isVoiceTranscriptExpanded: true }, 'Voice'],
  ['表情包', { text: '', sticker: { mediaAssetId: 'sticker-1' } }, 'Sticker'],
  ['图片', { text: '', attachments: [{ id: 'image-1', type: 'image' }] }, 'Attachment'],
  ['文件', { text: '', attachments: [{ id: 'file-1', type: 'file' }] }, 'Attachment'],
]) {
  for (const isMe of [true, false]) {
    const renderer = render(Bubble, {
      messageId: 1, text: '消息', senderType: isMe ? 'user' : 'assistant', isMe,
      userName: '枫渡', aiName: 'Raven', onPreviewFile: () => {}, ...extra,
    });
    assert.ok(text(renderer, isMe ? '枫渡：' : 'Raven：'), `${kind} 应显示发言者`);
    assert.equal(renderer.root.findAllByType('Avatar').length, 0);
    const content = renderer.root.findAllByType(expected).at(-1);
    assert.ok(content, `${kind} 内容应保留`);
    const ancestors = [];
    for (let node = content; node; node = node.parent) ancestors.push(flatten(node.props.style));
    assert.ok(ancestors.some((style) => style.width === '100%' && style.paddingHorizontal === theme.spacing.lg), `${kind} 应使用纸条页宽和缩进`);
    assert.ok(ancestors.every((style) => style.alignSelf !== 'flex-end' && style.justifyContent !== 'flex-end'), `${kind} 不应靠右`);
    act(() => renderer.unmount());
  }
}

// 一起听的两种发起人、生命周期和操作按钮保留；切换主题后恢复各自布局。
for (const isMe of [true, false]) {
  for (const [phase, actions] of [['pending_ai_response', []], ['pending_user_response', ['decline', 'accept']], ['active', ['leave']], ['ended', []]]) {
    theme = themes.at(-1);
    const calls = [];
    const props = {
      identity: { role: isMe ? 'user' : 'ai', isMe, name: isMe ? '枫渡' : 'Raven', avatarContent: null },
      viewModel: { activityId: 'listen-1', isMe, phase, title: '🎧 一起听', body: '状态正文', durationText: '01:23', actions },
      ...Object.fromEntries(['Accept', 'Decline', 'Leave'].map((action) => [`on${action}`, async (id) => { calls.push([action.toLowerCase(), id]); return { status: 'ok' }; }])),
    };
    const renderer = render(Card, props);
    const surface = renderer.root.findByType('Surface');
    assert.equal(surface.props.backgroundColor, 'transparent');
    assert.equal(flatten(surface.props.style).borderWidth, 0);
    assert.ok(text(renderer, isMe ? '枫渡：' : 'Raven：'));
    assert.ok(text(renderer, '状态正文'));
    assert.ok(text(renderer, '一起听时长 01:23'));
    assert.equal(renderer.root.findAllByType('Avatar').length, 0);
    for (const [index, action] of actions.entries()) {
      await act(async () => renderer.root.findAllByType('TouchableOpacity')[index].props.onPress());
      assert.deepEqual(calls.at(-1), [action, 'listen-1']);
    }
    theme = themes[0];
    act(() => renderer.update(themedElement(Card, props)));
    assert.equal(renderer.root.findAllByType('Avatar').length, 1);
    assert.equal(flatten(renderer.root.findByType('Surface').parent.props.style).justifyContent, isMe ? 'flex-end' : 'flex-start');
    act(() => renderer.unmount());
  }
}
// DIY 只替换普通消息背景；正文与媒体仍由现有组件渲染，切主题/素材失效恢复默认外观。
const config = { slices: { left: 3, top: 3, right: 3, bottom: 3 },
  padding: { left: 18, top: 12, right: 14, bottom: 10 }, scale: 1 };
skinSnapshot = Object.fromEntries(['user', 'ai'].map(role => [role, {
  role, textColor: '#445566', mediaAssetId: role, uri: `file:///${role}.png`, width: 12, height: 12, config, error: null,
  decorations: [{ id: 'logo', role, mediaAssetId: 'logo', uri: 'file:///logo.png', error: null, width: 200, height: 50,
    config: { anchor: 'bottom-left', size: 80, offsetX: -8, offsetY: -10 } }],
}]));
for (const supportedTheme of themes.slice(0, 2)) for (const isMe of [true, false]) {
  theme = supportedTheme;
  const props = { messageId: 99, clientMessageId: 'stable-bubble', text: 'DIY 正文', isMe, senderType: isMe ? 'user' : 'assistant', onPreviewFile: () => {} };
  const renderer = render(Bubble, props);
  assert.ok(text(renderer, 'DIY 正文'));
  assert.equal(renderer.root.findByType('SkinBackground').props.source.uri, `file:///${isMe ? 'user' : 'ai'}.png`);
  const frameStyle = flatten(renderer.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style);
  assert.equal(frameStyle.backgroundColor, 'transparent');
  assert.equal(frameStyle.paddingLeft, 18, '内容留白不使用拉伸切线代替');
  assert.equal(frameStyle.overflow, 'visible', '允许小装饰伸出气泡');
  assert.equal(frameStyle.marginBottom, 10, '首轮绘制前已包含装饰占位，不等待 onLayout 再补高');
  assert.equal(frameStyle.marginTop, 0);
  const ornament = renderer.root.findByType('Image');
  assert.deepEqual(ornament.props.style, { position: 'absolute', width: 80, height: 20, left: -8, bottom: -10 });
  assert.equal(ornament.parent.props.pointerEvents, 'none', '装饰整层不抢消息长按或选择');
  assert.equal(ornament.parent.props.style[1].zIndex, 2, '小装饰位于正文上层');
  const front = renderer.root.findByType(decorations.BubbleDecorationLayer);
  assert.equal(front.parent.children.at(-1), front, '装饰绘制顺序在正文之后');
  const beforeLateLayout = layoutNotifications;
  act(() => front.findByType('View').props.onLayout({ nativeEvent: { layout: { width: 20, height: 20 } } }));
  assert.equal(layoutNotifications, beforeLateLayout, '迟到的 onLayout 不再重复通知列表重排');
  const beforeCommitLayout = layoutNotifications;
  act(() => renderer.update(themedElement(Bubble, { ...props, messageId: 199 })));
  assert.equal(layoutNotifications, beforeCommitLayout, '同一消息落库只换数据库 ID，不能先撤掉装饰占位再补高');
  assert.equal(flatten(renderer.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style).marginBottom, 10,
    '同一条消息落库后继续保留装饰占位');
  act(() => renderer.update(themedElement(Bubble, { ...props, messageId: 199, clientMessageId: 'another-bubble' })));
  assert.equal(flatten(renderer.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style).marginBottom, 10,
    '回收成另一条消息时重新测量占位');
  nativeBubbleBounds = { width: 20, height: 20 };
  act(() => renderer.update(themedElement(Bubble, { ...props, messageId: 199, text: '短' })));
  assert.equal(flatten(renderer.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style).marginBottom, 3,
    '正文尺寸改变也在当前提交更新占位，不等异步事件后再移动');
  nativeBubbleBounds = { width: 240, height: 120 };
  for (const otherTheme of themes.slice(2)) {
    theme = otherTheme;
    act(() => renderer.update(themedElement(Bubble, props)));
    assert.equal(renderer.root.findAllByType('SkinBackground').length, 0, `${theme.id} 不套用 DIY 气泡`);
    assert.ok(text(renderer, 'DIY 正文'));
  }
  theme = supportedTheme;
  act(() => renderer.update(themedElement(Bubble, props)));
  assert.equal(renderer.root.findAllByType('SkinBackground').length, 1, '切回支持主题继续显示已保存皮肤');
  act(() => renderer.unmount());
}
theme = themes[0];
// 分享卡片不使用正文气泡、纸条横线、箭头或 DIY 装饰；玻璃主题只保留无额外内边距的材质层。
for (theme of themes) {
  for (const [extra, expected] of [
    [{ sharedRecord: { entries: [] } }, 'SharedRecord'],
    [{ sharedMoment: { momentId: 'original-author' } }, 'Moment'],
  ]) for (const isMe of [true, false]) {
    const props = { messageId: 200, text: '', isMe, senderType: isMe ? 'user' : 'assistant', onPreviewFile() {}, ...extra };
    const renderer = render(Bubble, props);
    const ancestors = [];
    for (let node = renderer.root.findByType(expected).parent; node; node = node.parent) {
      if (node.type === 'View' || node.type === 'GlassSurface') ancestors.push(flatten(node.props.style));
    }
    assert.equal(renderer.root.findAllByType('SkinBackground').length, 0, `${theme.id} 分享不套 DIY 皮肤`);
    assert.equal(renderer.root.findAllByType(frame.default).length, 0, `${theme.id} 分享不套纸条框`);
    assert.ok(ancestors.every(style => !style.paddingHorizontal && !style.paddingVertical), `${theme.id} 分享外部无正文留白`);
    assert.ok(renderer.root.findAllByType('View').every(node => !flatten(node.props.style).transform), `${theme.id} 分享没有气泡箭头`);
    if (theme.effects.glass.enabled) {
      assert.equal(renderer.root.findAllByType('GlassSurface').length, 1, '保留一层玻璃材质');
    } else {
      assert.ok(ancestors.every(style => !style.backgroundColor), `${theme.id} 分享外部不叠气泡背景`);
    }
    act(() => renderer.update(themedElement(Bubble, { ...props, sharedRecord: null, sharedMoment: null, text: '普通消息' })));
    if (variants.supportsChatBubbleSkins(theme)) assert.equal(renderer.root.findAllByType('SkinBackground').length, 1, '同一实例改回正文后恢复 DIY 皮肤');
    act(() => renderer.unmount());
  }
}
theme = themes[0];
for (const extra of [
  { text: '', attachments: [{ id: 'image', type: 'image' }] },
  { senderType: 'system' },
]) {
  const renderer = render(Bubble, { messageId: 100, text: '系统', isMe: false, senderType: 'assistant',
    onPreviewFile: () => {}, ...extra });
  assert.equal(renderer.root.findAllByType('SkinBackground').length, 0);
  act(() => renderer.unmount());
}
skinSnapshot.user = { ...skinSnapshot.user, uri: null, error: 'missing' };
const unavailable = render(Bubble, { messageId: 101, text: '素材不可用仍展示正文', isMe: true, senderType: 'user', onPreviewFile: () => {} });
assert.equal(unavailable.root.findAllByType('SkinBackground').length, 0);
assert.ok(text(unavailable, '素材不可用仍展示正文'));
act(() => unavailable.unmount());

// 预览覆写的外观经过同一消息渲染器；切换草稿时不能被 memo 忽略。
const preview = { skin: { ...skinSnapshot.ai, uri: 'file:///draft.png' } };
const livePreview = render(Bubble, { messageId: -1, text: '**强调**和 `代码`', isMe: false,
  senderType: 'assistant', onPreviewFile: () => {}, appearancePreview: preview });
assert.equal(livePreview.root.findByType('SkinBackground').props.source.uri, 'file:///draft.png');
assert.equal(livePreview.root.findByType(contents.BubbleTextContent).props.markdownStyles.codeInline.backgroundColor, 'transparent');
const preview2 = { skin: { ...preview.skin, textColor: '#123456', config: { ...config, padding: { ...config.padding, left: 35 } } } };
act(() => livePreview.update(themedElement(Bubble, { messageId: -1, text: '**强调**和 `代码`', isMe: false,
  senderType: 'assistant', onPreviewFile: () => {}, appearancePreview: preview2 })));
assert.equal(flatten(livePreview.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style).paddingLeft, 35);
assert.equal(livePreview.root.findByType(contents.BubbleTextContent).props.markdownStyles.codeInline.color, '#123456', '正文和 Markdown 使用组合字色');
theme = { ...theme, colors: { ...theme.colors, chat: { ...theme.colors.chat, aiText: '#223344' } } };
act(() => livePreview.update(themedElement(Bubble, { messageId: -1, text: '**强调**和 `代码`', isMe: false,
  senderType: 'assistant', onPreviewFile: () => {}, appearancePreview: preview2 })));
assert.equal(livePreview.root.findByType(contents.BubbleTextContent).props.markdownStyles.codeInline.color, '#123456', '主题色变化不会覆盖组合字色');
act(() => livePreview.unmount());

// 编辑页的单条预览必须能独立挂载真实 MessageBubble，所需上下文由预览自己持有。
const editorStyles = load('src/features/chat/appearance/presentation/BubbleSkinEditor.styles.ts', base);
const { BubbleSkinPreview } = load('src/features/chat/appearance/presentation/BubbleSkinPreview.tsx', {
  ...base, '../../presentation/messages/MessageBubble': { __esModule: true, default: Bubble },
  '../../presentation/messages/components/reasoningExpansionState': expansion,
  './BubbleSkinEditor.styles': editorStyles,
});
for (const role of ['user', 'ai']) for (const sample of ['好', ' ', '', '  \n  ', '很长的普通预览消息。'.repeat(120)]) {
  let renderer;
  act(() => { renderer = create(React.createElement(themeContext.Provider, { value: themes[0] },
    React.createElement(BubbleSkinPreview, { role, text: sample, appearance: preview })), { createNodeMock: nativeNode }); });
  assert.equal(renderer.root.findAllByType('SkinBackground').length, 1);
  if (sample.length > 0) assert.ok(text(renderer, sample), '单字、空白和长文本均原样进入正式正文组件');
  assert.equal(text(renderer, '展开全文'), undefined, '长文本编辑预览直接完整显示');
  const previewFrame = flatten(renderer.root.findByType(skinDrawing.BubbleSkinDrawing).parent.props.style);
  assert.equal(previewFrame.overflow, 'visible', '短文本不会裁掉气泡外的装饰');
  assert.equal(renderer.root.findByType('Image').props.style.left, -8, '正式预览保留装饰的负偏移');
  act(() => renderer.unmount());
}
console.log('Paper Note 与 DIY 消息/预览布局回归验证通过。');
