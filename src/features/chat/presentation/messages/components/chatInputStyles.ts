/** 定义聊天输入区及其主题快捷操作的样式。 */

import { StyleSheet } from 'react-native';

import type { PresentationTheme } from '@shared/theme';

// Moon Kimi 局部视觉常量，不构成独立主题系统。
const MOON_KIMI_CHIP_H_PADDING = 14;
const MOON_KIMI_CHIP_ICON_TEXT_GAP = 6;
export const GLASS_COMPOSER_CONTROL_SIZE = 44;

export function createInputAreaStyles(theme: PresentationTheme) {
  const usesGlass = theme.effects.glass.enabled;
  const glassRadius = GLASS_COMPOSER_CONTROL_SIZE / 2;

  return StyleSheet.create({
    container: {
      // 透明背景使回复预览自然悬浮在聊天背景上。
    },
    replyPreviewContainer: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 30,
      marginTop: 8,
      marginBottom: 8,
      paddingHorizontal: 10,
      paddingVertical: 3,
      backgroundColor: theme.colors.chat.quote,
      borderRadius: theme.radius.mini,
    },
    replyPreviewTextContainer: {
      flex: 1,
    },
    replyPreviewText: {
      fontSize: 13,
      color: theme.colors.text.secondary,
    },
    replyCancelBtn: {
      padding: 4,
      marginLeft: 8,
    },
    inputContainer: {
      flexDirection: 'row',
      padding: 8,
      paddingHorizontal: 12,
      borderTopWidth: usesGlass ? 0 : 0.5,
      borderTopColor: theme.colors.border.light,
      backgroundColor: usesGlass ? 'transparent' : theme.colors.chat.inputBar,
      alignItems: 'center',
      gap: usesGlass ? 6 : 0,
    },
    glassField: {
      flex: 1,
      minWidth: 0,
      borderRadius: glassRadius,
      flexDirection: 'row',
      alignItems: 'center',
    },
    glassFieldReplyButton: {
      width: GLASS_COMPOSER_CONTROL_SIZE,
      height: GLASS_COMPOSER_CONTROL_SIZE,
    },
    glassInputWithReplyButton: {
      paddingRight: 4,
    },
    glassButton: {
      width: GLASS_COMPOSER_CONTROL_SIZE,
      height: GLASS_COMPOSER_CONTROL_SIZE,
      borderRadius: glassRadius,
    },
    glassButtonTouchTarget: {
      width: '100%',
      height: '100%',
    },
    moonKimiInputContainer: {
      borderTopWidth: 0,
      backgroundColor: theme.colors.background.screen,
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: theme.spacing.sm,
      flexDirection: 'column',
      alignItems: 'stretch',
    },
    moonKimiInputBar: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: theme.colors.chat.input,
      borderRadius: theme.radius.xl,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 10,
      minHeight: 56,
    },
    input: {
      flex: 1,
      backgroundColor: theme.colors.chat.input,
      borderRadius: 6,
      paddingHorizontal: 12,
      paddingVertical: 8,
      paddingTop: 8,
      // 右侧间距按“可见墨迹”算，见 rightActions 的 12 约定。
      marginRight: usesGlass ? 0 : 3,
      fontSize: 16,
      color: theme.colors.text.primary,
      maxHeight: 100,
      minHeight: usesGlass ? GLASS_COMPOSER_CONTROL_SIZE : 36,
      borderWidth: usesGlass ? 0 : 0.5,
      borderColor: theme.colors.border.default,
    },
    moonKimiInput: {
      flex: 1,
      backgroundColor: 'transparent',
      borderWidth: 0,
      paddingHorizontal: theme.spacing.sm,
      paddingVertical: 8,
      paddingTop: 8,
      minHeight: 36,
      fontSize: theme.typography.body.fontSize,
      color: theme.colors.text.primary,
      maxHeight: 100,
      textAlignVertical: 'center',
    },
    moonKimiInputIconButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
    },
    moonKimiVoiceButton: {
      width: 25,
      height: 25,
      borderRadius: 17,
      borderWidth: 2,
      borderColor: theme.colors.icon.primary,
      justifyContent: 'center',
      alignItems: 'center',
    },
    rightActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: usesGlass ? 6 : 0,
      // 可见间距统一 12：输入框 3 右边距 + 按钮 marginLeft + 图标在 32 盒里的 3 内缩 = 12；
      // 发送是实心圆没有内缩，所以它的 marginLeft 单独取 9。
    },
    iconButton: {
      width: 32,
      height: 32,
      justifyContent: 'center',
      alignItems: 'center',
      marginLeft: usesGlass ? 0 : 6,
    },
    iconButtonActive: {},
    voiceButton: {
      width: 32,
      height: 32,
      justifyContent: 'center',
      alignItems: 'center',
      marginRight: usesGlass ? 0 : 8,
    },
    voiceErrorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      marginHorizontal: 12,
      marginBottom: 6,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.feedback.error,
      backgroundColor: theme.colors.chat.inputBar,
    },
    voiceErrorText: {
      flex: 1,
      marginLeft: 6,
      fontSize: 13,
      color: theme.colors.feedback.error,
    },
    voiceReviewContainer: {
      marginHorizontal: 12,
      marginBottom: 6,
      paddingHorizontal: 12,
      paddingTop: 10,
      paddingBottom: 10,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: theme.colors.border.default,
      backgroundColor: theme.colors.chat.inputBar,
      gap: 8,
    },
    voiceReviewHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    voiceReviewTitle: {
      flex: 1,
      fontSize: 13,
      fontWeight: '500',
      color: theme.colors.text.secondary,
    },
    voiceReviewDuration: {
      fontSize: 12,
      color: theme.colors.text.tertiary,
    },
    voiceReviewInput: {
      minHeight: 64,
      maxHeight: 140,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 8,
      fontSize: 15,
      lineHeight: 21,
      color: theme.colors.text.primary,
      backgroundColor: theme.colors.surface.default,
    },
    voiceReviewActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 8,
    },
    voiceReviewButton: {
      minWidth: 72,
      height: 36,
      paddingHorizontal: 16,
      borderRadius: 18,
      alignItems: 'center',
      justifyContent: 'center',
    },
    voiceReviewCancelButton: {
      borderWidth: 1,
      borderColor: theme.colors.border.default,
      backgroundColor: theme.colors.surface.default,
    },
    voiceReviewSendButton: {
      backgroundColor: theme.colors.brand.primary,
    },
    voiceReviewSendButtonDisabled: {
      opacity: 0.45,
    },
    voiceReviewButtonText: {
      fontSize: 14,
      fontWeight: '500',
    },
    moonKimiQuickActionsContainer: {
      paddingHorizontal: theme.spacing.lg,
      paddingTop: theme.spacing.sm,
      paddingBottom: theme.spacing.sm,
      backgroundColor: theme.colors.chat.inputBar,
    },
    moonKimiQuickActionsContent: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.spacing.sm,
    },
    moonKimiQuickAction: {
      minHeight: 36,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: MOON_KIMI_CHIP_H_PADDING,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: theme.colors.border.default,
      backgroundColor: theme.colors.surface.default,
    },
    moonKimiQuickActionText: {
      marginLeft: MOON_KIMI_CHIP_ICON_TEXT_GAP,
      fontSize: theme.typography.bodySmall.fontSize,
      color: theme.colors.text.primary,
    },
    sendButton: {
      // 实心圆没有 32 盒的内缩，补满与图标按钮相同的可见间距（12 - 3）。
      marginLeft: usesGlass ? 0 : 9,
    },
    moonKimiSendButton: {
      // 尺寸与配色由 ChatSendButton 决定，这里只对齐两侧间距。
      marginLeft: theme.spacing.xs,
      // 可见圆形的右边缘需要与左侧语音图标的可见圆形对齐。
      marginRight: 5,
    },
    moonKimiDisclaimer: {
      textAlign: 'center',
      fontSize: theme.typography.caption.fontSize,
      color: theme.colors.text.tertiary,
      marginTop: theme.spacing.sm,
    },
  });
}
