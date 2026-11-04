/** 资料页共用读取和不可用状态；编辑草稿仅在独立编辑页挂载。 */
import React, { type ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useThemedStyles } from '@shared/theme';
import { Button, EmptyState } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import type { AIProfile } from '../../domain/AIProfile';
import { useAIAssistantProfile } from './useAIAssistantProfile';
import { createAssistantProfileStyles } from './AssistantProfile.styles';

interface Props {
  aiId: string;
  title: string;
  onBack(): void;
  children(assistant: AIProfile): ReactNode;
}

export default function AssistantProfilePage({ aiId, title, onBack, children }: Props) {
  const styles = useThemedStyles(createAssistantProfileStyles);
  const { assistant, loading, error, reload } = useAIAssistantProfile(aiId);
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    {loading ? <><NavigationHeader title={title} onGoBack={onBack} /><ActivityIndicator style={styles.loading} /></>
      : error ? <><NavigationHeader title={title} onGoBack={onBack} />
        <View style={styles.loading}><Text style={styles.empty}>资料读取失败</Text><Button title="重试" onPress={reload} /></View></>
        : assistant ? children(assistant)
          : <><NavigationHeader title={title} onGoBack={onBack} />
            <EmptyState title="找不到这个 AI" description="这个 AI 可能已被删除。" /></>}
  </SafeAreaView>;
}
