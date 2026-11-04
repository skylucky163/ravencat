/** 独立选字窗口保留原文换行，不改变聊天正文的排版和长按手势。 */
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { TextSelectionScrollView } from '@platform/device';
import { ModalSheet } from '@shared/ui';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';

export default function ChatMessageTextSelectionSheet({ text, onClose }: {
  text: string;
  onClose: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <ModalSheet visible title="选择文字" onClose={onClose}>
      <Text style={styles.hint}>长按原文，拖动手柄选择，再点「复制」。</Text>
      <TextSelectionScrollView style={styles.body} contentContainerStyle={styles.content}>
        {/* 整段原文放在同一个 Text 中，让系统选区可以跨换行和段落。 */}
        <Text selectable style={styles.text}>{text}</Text>
      </TextSelectionScrollView>
    </ModalSheet>
  );
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  hint: {
    ...theme.typography.caption,
    color: theme.colors.text.secondary,
    paddingHorizontal: theme.spacing.lg,
    paddingTop: theme.spacing.md,
  },
  body: { flexGrow: 0, flexShrink: 1 },
  content: { padding: theme.spacing.lg },
  text: { ...theme.typography.body, color: theme.colors.text.primary },
});
