/** AI 朋友圈仍是用户的查看视角，资料由 Assistants 查询，互动沿用用户命令。 */
import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getAssistantDisplayName, useAIAssistantProfile } from '@features/assistants';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { Button, EmptyState } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import MomentsTab from './MomentsTab';

interface Props {
  aiId: string;
  refreshRevision: number;
  onBack(): void;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.app },
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.lg },
  error: { color: theme.colors.text.secondary },
});

export default function AssistantMomentsScreen({ aiId, refreshRevision, onBack }: Props) {
  const { assistant, loading, error, reload } = useAIAssistantProfile(aiId);
  const styles = useThemedStyles(createStyles);
  if (!loading && !error && assistant) return <MomentsTab key={assistant.agentId}
    refreshRevision={refreshRevision} onBack={onBack}
    assistant={{ agentId: assistant.agentId, name: getAssistantDisplayName(assistant), avatar: assistant.avatar,
      profileCoverMediaAssetId: assistant.profileCoverMediaAssetId }} />;
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="朋友圈" onGoBack={onBack} />
    {loading ? <ActivityIndicator style={styles.status} />
      : error ? <View style={styles.status}><Text style={styles.error}>资料读取失败</Text><Button title="重试" onPress={reload} /></View>
        : <EmptyState title="找不到这个 AI" description="这个 AI 可能已被删除。" />}
  </SafeAreaView>;
}
