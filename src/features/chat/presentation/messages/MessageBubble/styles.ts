/** 定义消息气泡及其主题变体的基础布局样式。 */

import { Dimensions, StyleSheet } from 'react-native';
import { isMoonKimiTheme } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import { createMessageTextStyles } from './textStyles';
import { createPaperNoteMessageStyles } from './paperNoteStyles';
import { createMessageBubbleSupplementStyles } from './supplementStyles';

/** 用户长文本气泡：正文超过该字符数默认折叠，防止一条长消息霸屏。 */
export const USER_TEXT_COLLAPSE_THRESHOLD = 500;

export function createMessageBubbleStyles(theme: PresentationTheme) {
  const isMoonKimi = isMoonKimiTheme(theme);

  const styles = StyleSheet.create({
    container: {
      marginVertical: 4,
      maxWidth: isMoonKimi ? '92%' : '84%',
      flexDirection: 'row',
      alignItems: 'flex-start',
      // 头像与气泡之间额外留出呼吸间距；头像自身 marginHorizontal 只负责贴屏幕边缘的留白。
      gap: theme.spacing.sm,
    },
    myContainer: isMoonKimi ? {
      alignSelf: 'flex-end',
      flexDirection: 'row',
      marginLeft: 0,
      marginRight: theme.spacing.lg,
      paddingRight: 0,
      // 子级使用百分比宽度，父级必须提供明确宽度，避免 FlashList 回收时把内容测量为 0。
      width: '80%',
    } : {
      alignSelf: 'flex-end',
      flexDirection: 'row',
      marginLeft: 50,
      paddingRight: 0,
    },
    aiContainer: isMoonKimi ? {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      marginRight: 0,
      marginLeft: theme.spacing.lg,
      paddingLeft: 0,
      width: '90%',
    } : {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      marginRight: 50,
      paddingLeft: 0,
    },
    reasoningContainer: isMoonKimi ? {
      alignSelf: 'flex-start',
      flexDirection: 'column',
      marginLeft: theme.spacing.lg,
      paddingLeft: 0,
      width: '90%',
    } : {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      marginRight: 50,
      paddingLeft: 0,
    },
    toolStatusContainer: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      paddingLeft: 6,
      width: '100%',
    },
    systemContainer: {
      alignSelf: 'center',
      flexDirection: 'row',
      justifyContent: 'center',
      width: '100%',
      marginVertical: 8,
    },
    avatarWrapper: {
      // 只负责占位与边距：尺寸必须与 Avatar 的 size 一致，圆角和裁切交给 AvatarImage，
      // 否则外层圆角会把头像四角二次削掉一点（表现为头像被裁）。
      width: 36,
      height: 36,
      justifyContent: 'center',
      alignItems: 'center',
      marginHorizontal: 6,
      alignSelf: 'flex-start',
    },
    avatarImage: {
      width: 36,
      height: 36,
      borderRadius: 4,
    },
    avatarEmoji: {
      fontSize: 20,
    },
    avatarText: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.colors.brand.primary,
    },
    bubbleWrapper: {
      maxWidth: '100%',
      flexShrink: 1,
      minWidth: 0,
    },
    fullWidthContainer: {
      width: '100%',
    },
    fullWidthBubbleWrapper: {
      flex: 1,
    },
    fullWidthBubble: {
      width: '100%',
    },
    moonKimiUserBubbleWrapper: {
      width: '100%',
    },
    moonKimiAssistantBubbleWrapper: {
      width: '100%',
    },
    myBubbleWrapper: {
      alignItems: 'flex-end',
    },
    aiBubbleWrapper: {
      alignItems: 'flex-start',
    },
    // 群聊 AI 发送者名：高度 17 使气泡小三角尖端（名字高度 + marginTop 14 + 半箭头 5）
    // 恰好落在 y=36，与 36px 头像底边对齐。
    assistantNameLabel: {
      height: 17,
      fontSize: 12,
      lineHeight: 17,
      color: theme.colors.text.secondary,
    },
    bubble: {
      position: 'relative',
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: theme.effects.glass.enabled ? theme.radius.lg : 4,
      maxWidth: '100%',
      flexShrink: 1,
      alignSelf: 'flex-start',
      overflow: 'hidden',
      zIndex: 1,
    },
    framelessAttachmentBubble: {
      paddingVertical: 0,
      paddingHorizontal: 0,
      borderRadius: 0,
      backgroundColor: 'transparent',
      maxWidth: 220,
    },
    // 分享卡片自己持有内容留白；玻璃层只负责材质，不再叠加正文气泡的内边距。
    sharedCardGlassSurface: {
      paddingVertical: 0,
      paddingHorizontal: 0,
    },
    attachmentsContainer: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
    },
    attachmentsContainerWithText: {
      marginBottom: 8,
    },
    attachmentItemSpacing: {
      marginTop: 8,
    },
    myBubble: isMoonKimi ? {
      backgroundColor: theme.colors.chat.bubbleUser,
      borderRadius: 12,
      maxWidth: '100%',
      alignSelf: 'flex-end',
    } : {
      backgroundColor: theme.colors.chat.bubbleUser,
    },
    aiBubble: isMoonKimi ? {
      backgroundColor: 'transparent',
      borderRadius: 0,
      borderWidth: 0,
      paddingVertical: 0,
      paddingHorizontal: 0,
      width: '100%',
      maxWidth: '100%',
    } : {
      backgroundColor: theme.colors.chat.bubbleAI,
    },
    reasoningContent: {
      paddingVertical: 4,
      paddingHorizontal: 0,
      marginLeft: theme.spacing.md,
      maxWidth: '100%',
      lineHeight: 22,
    },
    moonKimiProcessCard: {
      backgroundColor: theme.colors.background.app,
      borderWidth: 1,
      borderColor: theme.colors.border.default,
      borderRadius: theme.radius.md,
      paddingVertical: 0,
      paddingHorizontal: theme.spacing.lg,
      marginVertical: theme.spacing.sm,
      alignSelf: 'stretch',
    },
    moonKimiProcessHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      height: 43,
    },
    moonKimiProcessIcon: {
      marginRight: theme.spacing.sm,
    },
    moonKimiProcessLabel: {
      flexGrow: 1,
      flexShrink: 1,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: 20,
      color: theme.colors.text.secondary,
    },
    moonKimiProcessBody: {
      marginTop: theme.spacing.sm,
      maxHeight: Dimensions.get('window').height * 0.33,
    },
    moonKimiProcessBodyContent: {
      paddingBottom: theme.spacing.md,
    },
    systemBubble: {
      backgroundColor: 'transparent',
      alignSelf: 'center',
      paddingVertical: 4,
      paddingHorizontal: 0,
      maxWidth: '80%',
    },
    // 折叠态裁剪高度约等于 500 字正文的渲染高度；纯文本与 markdown 共用同一裁剪。
    userTextCollapsedClip: {
      maxHeight: 480,
      overflow: 'hidden',
    },
    userTextFoldToggle: {
      marginTop: 6,
      alignSelf: 'flex-start',
    },
    userTextFoldToggleText: {
      fontSize: 13,
      color: theme.colors.chat.userText,
      opacity: 0.75,
    },
    toolStatusBubble: {
      alignSelf: 'flex-start',
      maxWidth: '100%',
    },
    toolStatusText: {
      fontSize: 11,
      textAlign: 'left',
    },
    reasoningHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 4,
      marginLeft: isMoonKimi ? theme.spacing.md : 6,
    },
    reasoningLabel: {
      fontSize: 11,
      color: theme.colors.text.secondary,
      marginRight: 4,
    },
    arrow: {
      fontSize: 11,
      color: theme.colors.text.secondary,
      transform: [{ rotate: '-90deg' }],
    },
    arrowExpanded: {
      transform: [{ rotate: '90deg' }],
    },
  });

  return {
    ...styles,
    ...createMessageTextStyles(theme),
    ...createPaperNoteMessageStyles(theme),
    ...createMessageBubbleSupplementStyles(theme),
  };
}
