/** 管理页只读取目标助手的既有会话，查看资料不执行聊天进入副作用。 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAIAssistantProfile, type AIProfile } from '@features/assistants';
import { useThemedStyles, type PresentationTheme } from '@shared/theme';
import { Button, EmptyState } from '@shared/ui';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { getCanonicalChatConversation } from '../../conversation/application/ChatPresentation';
import type { ChatSession } from '../../conversation/domain/SessionRepository';

interface Props {
  aiId: string;
  title: string;
  onBack(): void;
  children(assistant: AIProfile, conversation: ChatSession): ReactNode;
}

const createStyles = (theme: PresentationTheme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.background.app },
  status: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.lg },
  error: { color: theme.colors.text.secondary },
});

export default function AssistantConversationPage({ aiId, title, onBack, children }: Props) {
  const { assistant, loading, error, reload } = useAIAssistantProfile(aiId);
  const styles = useThemedStyles(createStyles);
  const [conversation, setConversation] = useState<ChatSession | null>(null);
  const [conversationLoading, setConversationLoading] = useState(true);
  const [conversationError, setConversationError] = useState(false);
  const [revision, setRevision] = useState(0);
  const assistantId = assistant?.id;
  useEffect(() => {
    if (!assistantId) return;
    let active = true;
    setConversationLoading(true);
    setConversationError(false);
    void getCanonicalChatConversation(assistantId).then(value => {
      if (active) setConversation(value);
    }).catch(() => { if (active) setConversationError(true); })
      .finally(() => { if (active) setConversationLoading(false); });
    return () => { active = false; };
  }, [assistantId, revision]);
  const retryConversation = () => setRevision(value => value + 1);

  if (!loading && !error && assistant && !conversationLoading && !conversationError && conversation) {
    return children(assistant, conversation);
  }
  return <SafeAreaView style={styles.screen} edges={['top', 'left', 'right', 'bottom']}>
    <NavigationHeader title={title} onGoBack={onBack} />
    {loading ? <ActivityIndicator style={styles.status} />
      : error ? <View style={styles.status}><Text style={styles.error}>资料读取失败</Text><Button title="重试" onPress={reload} /></View>
        : !assistant ? <EmptyState title="找不到这个 AI" description="这个 AI 可能已被删除。" />
          : conversationLoading ? <ActivityIndicator style={styles.status} />
            : conversationError ? <View style={styles.status}><Text style={styles.error}>会话读取失败</Text><Button title="重试" onPress={retryConversation} /></View>
              : <EmptyState title="找不到这个 AI 的会话" description={`暂时无法打开${title}。`}
                actionText="重试" onAction={retryConversation} />}
  </SafeAreaView>;
}
