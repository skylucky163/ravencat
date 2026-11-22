import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useThemedStyles, type PresentationTheme } from '@shared/theme';
import { ListItem, NavigationHeader } from '@shared/ui';

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.screen },
  content: { padding: theme.spacing.lg },
  sources: { borderRadius: theme.radius.lg, overflow: 'hidden' },
});

export default function ConversationImportScreen({ onBack, onOpenDeepSeek }: {
  onBack: () => void;
  onOpenDeepSeek: () => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom', 'left', 'right']}>
      <NavigationHeader title="对话导入" onGoBack={onBack} />
      <ScrollView contentContainerStyle={styles.content}>
        <ThemedSurface style={styles.sources} variant="card">
          <ListItem title="DeepSeek" subtitle="从官方 ZIP 导出链接导入对话" onPress={onOpenDeepSeek} />
        </ThemedSurface>
      </ScrollView>
    </SafeAreaView>
  );
}
