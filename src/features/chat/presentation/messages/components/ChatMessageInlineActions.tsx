/** 助手回复尾部的复制和分享入口。 */

import React, { memo } from 'react';
import { View, TouchableOpacity, StyleSheet, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Copy } from 'lucide-react-native';
import { useTheme, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { copyChatMessageText } from './copyChatMessageText';

interface ChatMessageInlineActionsProps {
  text: string;
  onShare?: () => void;
  style?: ViewStyle;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      width: '100%',
      marginTop: theme.spacing.md,
      marginBottom: theme.spacing.lg,
      flexDirection: 'row',
      alignItems: 'center',
    },
    actionButton: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    shareButton: {
      marginLeft: 'auto',
    },
  });

function ChatMessageInlineActions({ text, onShare, style }: ChatMessageInlineActionsProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);
  const canCopy = text.trim().length > 0;
  if (!canCopy && !onShare) return null;

  return (
    <View style={[styles.container, style]}>
      {canCopy && (
        <TouchableOpacity
          style={styles.actionButton}
          activeOpacity={0.7}
          hitSlop={9}
          accessibilityRole="button"
          accessibilityLabel="复制"
          onPress={() => copyChatMessageText(text)}
        >
          <Copy size={20} strokeWidth={1.8} color={theme.colors.icon.secondary} />
        </TouchableOpacity>
      )}
      {onShare && (
        <TouchableOpacity
          style={[styles.actionButton, styles.shareButton]}
          activeOpacity={0.7}
          hitSlop={9}
          accessibilityRole="button"
          accessibilityLabel="分享"
          onPress={onShare}
        >
          <Ionicons name="arrow-redo-outline" size={22} color={theme.colors.icon.secondary} />
        </TouchableOpacity>
      )}
    </View>
  );
}

export default memo(ChatMessageInlineActions);
