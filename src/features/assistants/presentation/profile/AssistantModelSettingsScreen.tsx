import React, { type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles } from '@shared/theme';
import { Button, EmptyState } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import AIModelSettings from '../management/AIModelSettings';
import { createAssistantProfileStyles } from './AssistantProfile.styles';
import { useAIAssistantProfile } from './useAIAssistantProfile';

interface AssistantModelSettingsScreenProps {
  aiId: string;
  onBack(): void;
  auxiliaryModelSettings: ReactNode;
}

export default function AssistantModelSettingsScreen({
  aiId,
  onBack,
  auxiliaryModelSettings,
}: AssistantModelSettingsScreenProps) {
  const { assistant, loading, error, reload } = useAIAssistantProfile(aiId);
  const styles = useThemedStyles(createAssistantProfileStyles);

  if (!loading && !error && assistant) {
    return <AIModelSettings
      key={assistant.id}
      aiAssistant={assistant}
      onBack={onBack}
      auxiliaryModelSettings={auxiliaryModelSettings}
    />;
  }

  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title="模型设置" onGoBack={onBack} />
    {loading ? <ActivityIndicator style={styles.loading} />
      : error ? <View style={styles.loading}>
        <Text style={styles.empty}>资料读取失败</Text>
        <Button title="重试" onPress={reload} />
      </View>
        : <EmptyState title="找不到这个 AI" description="这个 AI 可能已被删除。" />}
  </SafeAreaView>;
}
