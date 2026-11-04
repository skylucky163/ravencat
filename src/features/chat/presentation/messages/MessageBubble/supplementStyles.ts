/** 定义消息气泡的辅助信息、翻译卡片、选择态与气泡尾部（包装层 / 箭头）样式，避免主气泡样式继续膨胀。 */

import { StyleSheet } from 'react-native';
import { getChatPresentationVariant, isPaperNoteTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';

export function createMessageBubbleSupplementStyles(theme: PresentationTheme) {
  return StyleSheet.create({
    replyContainer: {
      marginTop: 6,
      paddingVertical: 6,
      paddingHorizontal: 10,
      borderRadius: theme.radius.sm,
      maxWidth: 260,
    },
    myReplyContainer: {
      alignSelf: isPaperNoteTheme(theme) ? 'flex-start' : 'flex-end',
      backgroundColor: theme.colors.chat.quote,
    },
    // 卡片内部按百分比布局，引用必须提供明确宽度，避免被短回复正文压缩。
    momentReplyContainer: {
      width: 260,
      maxWidth: '100%',
    },
    aiReplyContainer: {
      alignSelf: 'flex-start',
      backgroundColor: theme.colors.chat.quote,
    },
    replyText: {
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.text.secondary,
    },
    replyAuthorName: {
      fontSize: 13,
      fontWeight: '600',
      color: theme.colors.text.secondary,
      marginBottom: 4,
    },
    // 气泡尾部包装层：默认聊天变体（default / Liquid Glass）必须是 row —— 宽度沿 row 解析才能取到
    // 父级可用宽度，否则退回"最宽 block 单行宽"，含列表/表格的气泡会塌成一两个字一行
    // （箭头只是它的装饰子节点，是否渲染箭头由 shouldRenderBubbleArrow 决定，与这层布局语义无关）。
    // moon-kimi / paper-note 有各自的 definite width 契约，保持无样式（避免破坏如 user 气泡的 alignSelf 对齐）。
    bubbleWithArrow: getChatPresentationVariant(theme) === 'default'
      ? { flexDirection: 'row', alignItems: 'flex-start' }
      : {},
    // 箭头是纯装饰，必须绝对定位、不占 row 主轴空间：它在流内会净占 4px（width 10 + margin -6），
    // 把 row 撑到超出可用宽度，逼气泡走 flexShrink 收缩路径；而该路径下容器交叉轴尺寸取自收缩前的
    // 文本测量，边界文本（最长行正好压满内容宽）会被凭空多留一行 21px —— 即"消息间幽灵空白"。
    // left/right = -4 保持与气泡 6px 压边、tail 外露 4px 的原有视觉。
    arrowLeft: {
      position: 'absolute',
      left: -4,
      width: 10,
      height: 10,
      backgroundColor: theme.colors.chat.bubbleAI,
      borderRadius: 1.5,
      transform: [{ rotate: '45deg' }],
      marginTop: 14,
      zIndex: 0,
    },
    arrowRight: {
      position: 'absolute',
      right: -4,
      width: 10,
      height: 10,
      backgroundColor: theme.colors.chat.bubbleUser,
      borderRadius: 1.5,
      transform: [{ rotate: '45deg' }],
      marginTop: 14,
      zIndex: 0,
    },
    tokenInfo: {
      fontSize: 10,
      color: theme.colors.text.tertiary,
      marginTop: 2,
    },
    myTokenInfo: {
      alignSelf: 'flex-end',
      marginRight: theme.spacing.md,
    },
    aiTokenInfo: {
      alignSelf: 'flex-start',
      marginLeft: theme.spacing.md,
    },
    translationCard: {
      marginTop: 4,
      backgroundColor: theme.colors.background.app,
      borderRadius: theme.radius.sm,
      paddingVertical: 5,
      paddingHorizontal: 8,
      maxWidth: 260,
    },
    myTranslationCard: {
      alignSelf: isPaperNoteTheme(theme) ? 'flex-start' : 'flex-end',
    },
    aiTranslationCard: {
      alignSelf: 'flex-start',
    },
    translationText: {
      fontSize: 13,
      lineHeight: 18,
      color: theme.colors.text.primary,
    },
    translationMetaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginTop: 4,
    },
    translationCheck: {
      width: 12,
      height: 12,
      borderRadius: 6,
      backgroundColor: theme.colors.text.tertiary,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 4,
    },
    translationCheckText: {
      color: theme.colors.background.app,
      fontSize: 9,
      fontWeight: '700',
      lineHeight: 11,
    },
    translationMetaText: {
      flexShrink: 1,
      fontSize: 10,
      color: theme.colors.text.tertiary,
    },
    translationHideButton: {
      marginLeft: 6,
      paddingHorizontal: 3,
      paddingVertical: 1,
    },
    translationHideText: {
      fontSize: 10,
      color: theme.colors.text.secondary,
    },
    selectedBubbleOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: theme.colors.surface.overlay,
      borderRadius: theme.radius.sm,
      zIndex: 2,
    },
  });
}
