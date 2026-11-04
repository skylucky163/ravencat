/** 消息气泡中的文本、附件与翻译展示协作者。 */

import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Markdown, { MarkdownIt, hasParents } from 'react-native-markdown-renderer';
import { useMappingHelper } from '@shopify/flash-list';

import type { ChatAttachment } from '@features/chat/messages/domain';
import type { SenderType } from '@features/chat/messages/domain/ChatMessage';
import { isMoonKimiTheme, isPaperNoteTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import AttachmentCard from './AttachmentCard';
import { createMessageBubbleStyles } from './styles';
import { createSelectableMarkdownRenderer } from './selectableMarkdownRenderer';

export type BubbleVariant = 'me' | 'ai' | 'reasoning' | 'system';
export type BubbleStyles = ReturnType<typeof createMessageBubbleStyles>;
export type BubbleTranslation = {
  text: string;
  sourceLabel: string;
};
export type PreviewFileHandler = (params: {
  fileUri: string;
  fileName: string;
  mimeType?: string | null;
}) => void;

const MARKDOWN_SYNTAX_PATTERN = /(^#{1,6}\s)|(^\s*[-*+]\s)|(^\s*\d+\.\s)|(```)|(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(~~[^~]+~~)|(\[[^\]]+\]\([^\)]+\))|(^>\s)|(https?:\/\/\S+)/m;
const MARKDOWN_TABLE_PATTERN = /^\s*\|?.+\|.+\|?\s*\r?\n\s*\|?\s*:?-{3,}/m;
const WIDE_MARKDOWN_BLOCK_PATTERN = /(^\s*[-*+]\s)|(^\s*\d+\.\s)/m;
const SHARED_MARKDOWN_IT = MarkdownIt({ typographer: true, linkify: true });
const COMMON_PLAIN_TEXT_STYLE = {
  flexWrap: 'wrap',
  flexShrink: 0,
} as const;

/** Moon Kimi 主题下 AI 正文的段落间距，Markdown 与纯文本两条渲染路径共用。 */
export const MOON_KIMI_AI_PARAGRAPH_SPACING = 24;

export function getBubbleVariant(isMe: boolean, senderType: SenderType): BubbleVariant {
  if (isMe) {
    return 'me';
  }

  if (senderType === 'reasoning') {
    return 'reasoning';
  }

  if (senderType === 'system') {
    return 'system';
  }

  return 'ai';
}

export function shouldRenderMarkdownText(text: string | null | undefined): boolean {
  const rawText = String(text || '');
  return Boolean(rawText.trim()) && (
    MARKDOWN_SYNTAX_PATTERN.test(rawText) || MARKDOWN_TABLE_PATTERN.test(rawText)
  );
}

export function shouldUseWideMarkdownLayout(text: string | null | undefined): boolean {
  const rawText = String(text || '');
  return WIDE_MARKDOWN_BLOCK_PATTERN.test(rawText) || MARKDOWN_TABLE_PATTERN.test(rawText);
}

export function createMarkdownStylePreset(
  variant: BubbleVariant,
  theme: PresentationTheme,
  bubbleStyles: BubbleStyles,
  useWideLayout: boolean,
  /**
   * 气泡背景由用户上传的 PNG 承担时传 true。
   * 渲染库的样式是浅合并：没在这里给出的 key 会落到库默认值（浅色实底、标号默认黑）。
   */
  customBackground = false,
  textColorOverride?: string
) {
  const baseTextStyle = { ...StyleSheet.flatten(
    variant === 'me' ? bubbleStyles.myText :
    variant === 'ai' ? bubbleStyles.aiText :
    variant === 'reasoning' ? bubbleStyles.reasoningText :
    bubbleStyles.systemText
  ), ...(textColorOverride && { color: textColorOverride }) };
  const baseFontSize = typeof baseTextStyle.fontSize === 'number' ? baseTextStyle.fontSize : 15;
  const baseLineHeight = typeof baseTextStyle.lineHeight === 'number'
    ? baseTextStyle.lineHeight
    : baseFontSize + 6;
  const isMeVariant = variant === 'me';
  const usesUserBubbleColors = isMeVariant && !isPaperNoteTheme(theme);
  const userCodeBackground = theme.effects.glass.enabled
    ? 'rgba(255, 255, 255, 0.22)'
    : theme.colors.brand.onPrimary;

  const isMoonKimiAiVariant =
    isMoonKimiTheme(theme) && (variant === 'ai' || variant === 'reasoning');

  // DIY 背景是用户上传的图片，主题色和它没有任何关系：自绘实底会直接盖住图片，
  // 还会和正文色撞出低对比（白字压在浅色代码底上）。此时填充全部归零，
  // 所有可读性只从该侧正文色推导——正文色由气泡自己决定，Markdown 不应另立一套颜色。
  const textColor = baseTextStyle.color;
  const ruleColor = customBackground ? textColor : theme.colors.border.default;
  const codeInlineFill = customBackground
    ? 'transparent'
    : (usesUserBubbleColors ? userCodeBackground : theme.colors.surface.muted);
  const codeBlockFill = customBackground
    ? 'transparent'
    : (usesUserBubbleColors ? userCodeBackground : theme.colors.background.screen);
  const codeBlockColor = customBackground
    ? textColor
    : (usesUserBubbleColors && theme.effects.glass.enabled
      ? theme.colors.brand.onPrimary
      : theme.colors.text.primary);
  const linkColor = customBackground
    ? textColor
    : (usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.brand.primary);
  const quoteColor = customBackground
    ? textColor
    : (usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.text.secondary);
  const tableHeaderFill = customBackground ? 'transparent' : theme.colors.surface.muted;

  // 库的删除线/下划线规则只给装饰线、不给颜色，文字会落到平台默认黑。
  // 逐字标号（·、1.）同理：渲染库只给它们边距和行高。给出这些 key 会整体替换库默认，
  // 所以列表标号必须连库的 marginLeft/marginRight/lineHeight 一起复刻。仅 DIY 背景需要。
  const customBackgroundOverrides = customBackground
    ? {
        strikethrough: { color: textColor, textDecorationLine: 'line-through' as const },
        u: { color: textColor, textDecorationLine: 'underline' as const },
        listUnorderedItemIcon: { color: textColor, marginLeft: 10, marginRight: 10, lineHeight: 24 },
        listOrderedItemIcon: { color: textColor, marginLeft: 10, marginRight: 10, lineHeight: 24 },
      }
    : {};

  return {
    root: {
      width: useWideLayout ? '100%' : undefined,
      maxWidth: '100%',
      // 顶级 block 间距由 root 的 rowGap 统一承担：block 之间有间距，最后一个 block 后面没有间距。
      // 不用负 margin 抵消末块底距——最后一个 block 的类型不可预知（可能是标题/列表/引用/代码块等）。
      rowGap: isMoonKimiAiVariant ? MOON_KIMI_AI_PARAGRAPH_SPACING : 0,
      marginBottom: 0,
    },
    text: {
      ...baseTextStyle,
      flexWrap: 'wrap',
      flexShrink: 1,
      lineHeight: baseLineHeight,
    },
    // 单个 block 自身不承担尾部间距；paragraph 也可能嵌套在 list item / blockquote 内部，
    // 统一归零可以避免嵌套结构出现巨大行距。
    paragraph: {
      ...baseTextStyle,
      flexDirection: 'row',
      alignItems: 'flex-start',
      flexWrap: 'wrap',
      width: useWideLayout ? '100%' : undefined,
      marginBottom: 0,
      marginTop: 0,
    },
    // 渲染库的列表容器 key 是 list / listUnordered / listOrdered，没有 bullet_list / ordered_list；
    // 项目符号与序号在 listUnorderedItemIcon / listOrderedItemIcon。
    list: {
      marginBottom: 0,
      marginTop: 0,
    },
    // 渲染库对样式只做浅合并，这里出现的 key 会整体替换库默认；库默认带 marginBottom 的
    // 块级容器（pre / htmlBlock 等）在此显式归零，顶级间距统一由 root.rowGap 负责。
    pre: {
      marginBottom: 0,
    },
    htmlBlock: {
      marginBottom: 0,
    },
    // 细分隔线，替代渲染库默认的粗灰线
    hr: {
      height: 1,
      backgroundColor: ruleColor,
      marginVertical: theme.spacing.sm,
    },
    listItem: {
      flex: 1,
      flexWrap: 'wrap',
      flexShrink: 1,
      minWidth: 0,
    },
    listUnorderedItemText: {
      ...baseTextStyle,
      flexWrap: 'wrap',
      flexShrink: 0,
    },
    listOrderedItemText: {
      ...baseTextStyle,
      flexWrap: 'wrap',
      flexShrink: 0,
    },
    table: {
      width: '100%',
      maxWidth: '100%',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: ruleColor,
      marginBottom: 0,
    },
    tableHeader: {
      backgroundColor: tableHeaderFill,
    },
    tableHeaderCell: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 4,
      paddingHorizontal: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: ruleColor,
      fontWeight: '600' as const,
    },
    tableRow: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: ruleColor,
    },
    tableRowCell: {
      flex: 1,
      minWidth: 0,
      paddingVertical: 4,
      paddingHorizontal: 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: ruleColor,
    },
    strong: { ...baseTextStyle, fontWeight: '700' as const },
    em: { ...baseTextStyle, fontStyle: 'italic' as const },
    heading1: { ...baseTextStyle, fontSize: baseFontSize + 6, fontWeight: '700' as const },
    heading2: { ...baseTextStyle, fontSize: baseFontSize + 4, fontWeight: '700' as const },
    heading3: { ...baseTextStyle, fontSize: baseFontSize + 2, fontWeight: '700' as const },
    heading4: { ...baseTextStyle, fontWeight: '700' as const },
    heading5: { ...baseTextStyle, fontWeight: '700' as const },
    heading6: { ...baseTextStyle, fontWeight: '700' as const },
    // 渲染库对样式只做浅合并，标题容器 key 不覆盖就会保留库默认的
    // marginTop: 24 / marginBottom: 16，导致含标题的消息上下多出一截空白；
    // 与 paragraph 一样归零，顶级间距统一由 root.rowGap 负责。
    headingContainer: {
      marginTop: 0,
      marginBottom: 0,
    },
    // h1/h2 容器默认带 paddingBottom 和底部分隔线，聊天气泡里不需要。
    heading1Container: {},
    heading2Container: {},
    link: {
      ...baseTextStyle,
      color: linkColor,
      textDecorationLine: 'underline',
    },
    blockquote: {
      ...baseTextStyle,
      color: quoteColor,
      borderLeftColor: customBackground
        ? ruleColor
        : (usesUserBubbleColors ? theme.colors.brand.onPrimary : theme.colors.border.default),
      borderLeftWidth: 3,
      paddingLeft: 8,
      marginLeft: 0,
      marginBottom: 0,
    },
    // 代码只保留等宽与留白等语义，不在 DIY 背景上铺色块。
    codeInline: {
      ...baseTextStyle,
      fontFamily: 'monospace',
      backgroundColor: codeInlineFill,
      paddingHorizontal: 4,
      paddingVertical: 2,
      borderRadius: theme.radius.sm,
    },
    codeBlock: {
      fontFamily: 'monospace',
      fontSize: 14,
      lineHeight: 20,
      color: codeBlockColor,
      backgroundColor: codeBlockFill,
      padding: theme.spacing.sm,
      borderRadius: theme.radius.md,
      marginBottom: 0,
      width: 200,
    },
    ...customBackgroundOverrides,
  };
}

type MarkdownStylePreset = ReturnType<typeof createMarkdownStylePreset>;
type TextStyleProp = React.ComponentProps<typeof Text>['style'];

/**
 * 纯文本按“连续两个及以上换行”划分段落；单个换行是用户主动输入的普通换行，不算段落分隔。
 * 首尾的空段落（由开头/结尾的连续换行产生）被丢弃，避免渲染出无内容的尾部空白。
 */
export function splitPlainTextParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).filter((paragraph) => paragraph.length > 0);
}

const PlainTextBubbleText = memo(function PlainTextBubbleText({
  text,
  textStyle,
  paragraphSpacing,
  onTextLayout,
  selectable,
}: {
  text: string;
  textStyle: TextStyleProp;
  paragraphSpacing?: number | null;
  selectable: boolean;
  /** 开发态布局探针：纯文本行数/文本高度。是 prop 而不是包装层，不改变布局。 */
  onTextLayout?: (event: import('react-native').NativeSyntheticEvent<import('react-native').TextLayoutEventData>) => void;
}) {
  // 纯文本路径没有 Markdown 段落概念，moonKimi 下按连续换行手动分段以获得相同的段落间距。
  // 段间距由父容器 rowGap 统一承担，最后一个段落自然没有尾部间距，也不需要“最后一段不加 margin”的特例。
  // 可选思维链保留原文换行在同一个 Text 中，避免段落切断 Android 选区。
  if (paragraphSpacing && !selectable) {
    const paragraphs = splitPlainTextParagraphs(text);
    if (paragraphs.length > 1) {
      return (
        <View style={{ rowGap: paragraphSpacing }}>
          {paragraphs.map((paragraph, index) => (
            <Text key={index} selectable={selectable} style={textStyle} onTextLayout={index === 0 ? onTextLayout : undefined}>
              {paragraph}
            </Text>
          ))}
        </View>
      );
    }
  }

  return <Text selectable={selectable} style={textStyle} onTextLayout={onTextLayout}>{text}</Text>;
}, (previous, next) => (
  previous.text === next.text
  && previous.textStyle === next.textStyle
  && previous.paragraphSpacing === next.paragraphSpacing
  && previous.onTextLayout === next.onTextLayout
  && previous.selectable === next.selectable
));

/**
 * 开发态布局探针的 Markdown 测量点；探针关闭时整体为 undefined。
 *
 * 只保留列表节点（通过复刻 renderRules 注入 onLayout，不新增节点、不改样式）。
 * **刻意没有 `root`**：Markdown 根节点由渲染库内部创建，要测它就必须在库外再包一层 View，
 * 而包装层会改变 fit-content 宽度与收缩行为，测到的不是真实布局。所以 markdown 根层
 * 不参与 B（消息间空白）的判断——判断气泡内部是否闭合看 `bubble` 层即可。
 */
export interface MarkdownProbeHandlers {
  /** 纯文本路径的文本布局观测（行数/文本高度）；Markdown 路径没有这个观测点。 */
  plainTextLines?: (event: import('react-native').NativeSyntheticEvent<import('react-native').TextLayoutEventData>) => void;
  listOuter?: (event: import('react-native').LayoutChangeEvent) => void;
  listItemContent?: (event: import('react-native').LayoutChangeEvent) => void;
}

/** renderRules 的最小节点投影；只取探针用到的字段，避免依赖库内部类型。 */
interface MarkdownRenderNode {
  key: string | number;
  index?: number;
  markup?: string;
}

/** renderRules 的 styles 投影；与库 lib/styles.js 的 list 相关键对齐。 */
interface MarkdownRenderStyles extends Record<string, unknown> {
  list?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listUnordered?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listOrdered?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listItem?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listUnorderedItem?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listOrderedItem?: import('react-native').StyleProp<import('react-native').ViewStyle>;
  listUnorderedItemIcon?: import('react-native').StyleProp<import('react-native').TextStyle>;
  listOrderedItemIcon?: import('react-native').StyleProp<import('react-native').TextStyle>;
}

/**
 * 仅 `__DEV__` 且探针开启时使用的 Markdown list 渲染规则覆盖。
 *
 * 结构复刻 `react-native-markdown-renderer` v3 的 renderRules（bullet_list /
 * ordered_list / list_item），仅注入 onLayout，不改变任何样式与节点结构。
 * 复刻而非包装的原因：包装 View 会参与父级 stretch，测不到目标节点自身的宽度。
 * 若升级 renderer，需同步核对 renderRules.js 的 list 相关实现。
 */
function buildMarkdownListProbeRules(
  onListOuter: NonNullable<MarkdownProbeHandlers['listOuter']>,
  onListItemContent: NonNullable<MarkdownProbeHandlers['listItemContent']>
) {
  return {
    bullet_list: (node: MarkdownRenderNode, children: React.ReactNode[], parent: { type: string }[], styles: MarkdownRenderStyles) => (
      <View key={node.key} style={[styles.list, styles.listUnordered]} onLayout={onListOuter}>
        {children}
      </View>
    ),
    ordered_list: (node: MarkdownRenderNode, children: React.ReactNode[], parent: { type: string }[], styles: MarkdownRenderStyles) => (
      <View key={node.key} style={[styles.list, styles.listOrdered]} onLayout={onListOuter}>
        {children}
      </View>
    ),
    list_item: (node: MarkdownRenderNode, children: React.ReactNode[], parent: { type: string }[], styles: MarkdownRenderStyles) => {
      if (hasParents(parent, 'bullet_list')) {
        return (
          <View key={node.key} style={styles.listUnorderedItem}>
            <Text style={styles.listUnorderedItemIcon}>{'\u00B7'}</Text>
            <View style={[styles.listItem]} onLayout={onListItemContent}>
              {children}
            </View>
          </View>
        );
      }
      if (hasParents(parent, 'ordered_list')) {
        return (
          <View key={node.key} style={styles.listOrderedItem}>
            <Text style={styles.listOrderedItemIcon}>{node.index + 1}{node.markup}</Text>
            <View style={[styles.listItem]} onLayout={onListItemContent}>
              {children}
            </View>
          </View>
        );
      }
      return (
        <View key={node.key} style={[styles.listItem]} onLayout={onListItemContent}>
          {children}
        </View>
      );
    },
  };
}

const MarkdownBubbleText = memo(function MarkdownBubbleText({
  text,
  markdownStyle,
  probeHandlers,
  selectable,
}: {
  text: string;
  markdownStyle: MarkdownStylePreset;
  selectable: boolean;
  /** 开发态布局探针 handlers；关闭时为 undefined。 */
  probeHandlers?: MarkdownProbeHandlers;
}) {
  const selectableRenderer = useMemo(
    () => selectable ? createSelectableMarkdownRenderer(markdownStyle) : undefined,
    [markdownStyle, selectable]
  );
  if (selectableRenderer) {
    return <Markdown markdownit={SHARED_MARKDOWN_IT} renderer={selectableRenderer}>{text}</Markdown>;
  }
  const debugRules = probeHandlers?.listOuter && probeHandlers.listItemContent
    ? buildMarkdownListProbeRules(probeHandlers.listOuter, probeHandlers.listItemContent)
    : undefined;
  // 探针只通过 rules 注入 onLayout：渲染树与生产完全一致，不为测量新增任何包装节点。
  return (
    <Markdown
      style={markdownStyle}
      markdownit={SHARED_MARKDOWN_IT}
      rules={debugRules as never}
    >
      {text}
    </Markdown>
  );
}, (previous, next) => (
  previous.text === next.text
  && previous.markdownStyle === next.markdownStyle
  && previous.probeHandlers === next.probeHandlers
  && previous.selectable === next.selectable
));

export const BubbleTextContent = memo(function BubbleTextContent({
  hasTextContent,
  shouldUseMarkdown,
  text,
  markdownStyles,
  plainTextStyle,
  paragraphSpacing,
  probeHandlers,
  selectable = false,
}: {
  hasTextContent: boolean;
  shouldUseMarkdown: boolean;
  text: string;
  markdownStyles: MarkdownStylePreset | null;
  plainTextStyle: TextStyleProp;
  paragraphSpacing?: number | null;
  /** 思维链让 Android 原生文本选择拥有长按与复制菜单。 */
  selectable?: boolean;
  /** 开发态布局探针 handlers；关闭时为 undefined。 */
  probeHandlers?: MarkdownProbeHandlers;
}) {
  if (!hasTextContent) {
    return null;
  }

  return shouldUseMarkdown && markdownStyles ? (
    <MarkdownBubbleText
      text={text}
      markdownStyle={markdownStyles}
      probeHandlers={probeHandlers}
      selectable={selectable}
    />
  ) : (
    <PlainTextBubbleText
      text={text}
      textStyle={plainTextStyle}
      paragraphSpacing={paragraphSpacing}
      onTextLayout={probeHandlers?.plainTextLines}
      selectable={selectable}
    />
  );
}, (previous, next) => (
  previous.hasTextContent === next.hasTextContent
  && previous.shouldUseMarkdown === next.shouldUseMarkdown
  && previous.text === next.text
  && previous.markdownStyles === next.markdownStyles
  && previous.plainTextStyle === next.plainTextStyle
  && previous.paragraphSpacing === next.paragraphSpacing
  && previous.probeHandlers === next.probeHandlers
  && previous.selectable === next.selectable
));

export const BubbleAttachmentList = memo(function BubbleAttachmentList({
  attachments,
  hasTextContent,
  isMe,
  onPreviewFile,
  onAttachmentLongPress,
  styles,
}: {
  attachments: ChatAttachment[];
  hasTextContent: boolean;
  isMe: boolean;
  onPreviewFile: PreviewFileHandler;
  onAttachmentLongPress?: (position: { x: number; y: number }) => void;
  styles: BubbleStyles;
}) {
  const { getMappingKey } = useMappingHelper();
  if (!attachments.length) {
    return null;
  }

  return (
    <View style={hasTextContent ? [styles.attachmentsContainer, styles.attachmentsContainerWithText] : styles.attachmentsContainer}>
      {attachments.map((attachment, index) => (
        <View
          key={getMappingKey(attachment.id, index)}
          style={index > 0 ? styles.attachmentItemSpacing : undefined}
        >
          <AttachmentCard attachment={attachment} isMe={isMe} onPreview={onPreviewFile} onAttachmentLongPress={onAttachmentLongPress} />
        </View>
      ))}
    </View>
  );
}, (previous, next) => (
  previous.attachments === next.attachments
  && previous.hasTextContent === next.hasTextContent
  && previous.isMe === next.isMe
  && previous.onPreviewFile === next.onPreviewFile
  && previous.onAttachmentLongPress === next.onAttachmentLongPress
  && previous.styles === next.styles
));

export const TranslationBlock = memo(function TranslationBlock({
  translation,
  isMe,
  onHide,
  styles,
}: {
  translation: BubbleTranslation;
  isMe: boolean;
  onHide?: () => void;
  styles: BubbleStyles;
}) {
  return (
    <View style={[styles.translationCard, isMe ? styles.myTranslationCard : styles.aiTranslationCard]}>
      <Text style={styles.translationText}>{translation.text}</Text>
      <View style={styles.translationMetaRow}>
        <View style={styles.translationCheck}>
          <Text style={styles.translationCheckText}>✓</Text>
        </View>
        <Text style={styles.translationMetaText}>{translation.sourceLabel}</Text>
        <TouchableOpacity
          style={styles.translationHideButton}
          onPress={onHide}
          activeOpacity={0.7}
        >
          <Text style={styles.translationHideText}>隐藏</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}, (previous, next) => (
  previous.translation.text === next.translation.text
  && previous.translation.sourceLabel === next.translation.sourceLabel
  && previous.isMe === next.isMe
  && previous.onHide === next.onHide
  && previous.styles === next.styles
));

export { COMMON_PLAIN_TEXT_STYLE };
