/** 展示单聊详情功能菜单。 */
import { getAssistantDisplayName } from '@features/assistants';

import React from 'react';
import { Search } from 'lucide-react-native';
import { Pressable, StyleSheet, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import type { PresentationTheme } from '@shared/theme';
import NavigationHeader from '@shared/ui/NavigationHeader';
import { AIInfoCard, showAppDialog } from '@shared/ui';
import type { AIProfile } from '@features/assistants';
import {
  MenuSection,
  ProtocolIcon,
  ClearHistoryIcon,
  SettingsIcon,
  ChatSettingsIcon,
  SummaryIcon,
  StatisticsIcon,
  CallHistoryIcon,
} from './AIOptionsParts';

interface AIOptionsProps {
  conversationId?: string | null;
  aiAssistant?: AIProfile | null;
  onBack?: () => void;
  onProtocolSpace?: () => void;
  onClearHistory?: () => void | Promise<void>;
  onModelSettings?: () => void;
  onOpenProfile: () => void;
  onChatSettings?: () => void;
  onChatSummary?: () => void;
  onSearchMessages?: () => void;
  onCallHistory?: () => void;
  onChatStatistics?: () => void;
  onDeleteAI?: () => void | Promise<void>;
}

const createStyles = (theme: PresentationTheme) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: theme.colors.background.screen,
    },
    scrollView: {
      flex: 1,
    },
    aiInfoCard: {
      marginTop: theme.spacing.md,
      marginHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.lg,
      marginBottom: theme.spacing.md,
    },
    section: {
      marginHorizontal: theme.spacing.lg,
      borderRadius: theme.radius.lg,
      overflow: 'hidden',
      marginBottom: theme.spacing.md,
    },
    menuItem: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: theme.spacing.lg,
      paddingVertical: 16,
      borderBottomWidth: 0.5,
      borderBottomColor: theme.colors.border.light,
    },
    menuItemCenter: {
      justifyContent: 'center',
    },
    iconContainer: {
      marginRight: theme.spacing.md,
    },
    iconBox: {
      width: 32,
      height: 32,
      justifyContent: 'center',
      alignItems: 'center',
    },
    content: {
      flex: 1,
    },
    contentCenter: {
      flex: 0,
    },
    title: {
      fontSize: 16,
      color: theme.colors.text.primary,
      fontWeight: '400',
    },
    dangerTitle: {
      color: theme.colors.feedback.error,
    },
  });

export default function AIOptions({
  conversationId,
  aiAssistant,
  onBack,
  onProtocolSpace,
  onClearHistory,
  onModelSettings,
  onOpenProfile,
  onChatSettings,
  onChatSummary,
  onSearchMessages,
  onCallHistory,
  onChatStatistics,
  onDeleteAI,
}: AIOptionsProps) {
  const theme = useTheme();
  const styles = useThemedStyles(createStyles);

  const handleDeleteAI = () => {
    if (!aiAssistant?.name || !onDeleteAI) return;

    showAppDialog({
      title: '删除 AI 助手',
      message: `删除「${getAssistantDisplayName(aiAssistant)}」会永久清空它的会话、消息、通话记录、聊天摘要和专属记忆空间。若要保留数据，请先到设置中备份应用。确定继续吗？`,
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: onDeleteAI,
        },
      ],
    });
  };

  const handleClearHistory = () => {
    if (!onClearHistory) return;
    showAppDialog({
      title: '清除聊天记录',
      message: '将永久删除与当前 AI 的全部聊天记录，包括此前隐藏的消息和重写版本，无法撤销。\n聊天摘要和记忆空间的内容会继续保留。',
      buttons: [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: () => {
            void Promise.resolve(onClearHistory()).catch((error) => {
              showAppDialog({ title: '清除失败', message: error instanceof Error ? error.message : '请稍后再试。', tone: 'error' });
            });
          },
        },
      ],
    });
  };

  const settingsMenuItems = [
    {
      key: 'model-settings',
      icon: <SettingsIcon color={theme.colors.brand.primary} />,
      title: '模型设置',
      onPress: onModelSettings,
    },
    {
      key: 'chat-settings',
      icon: <ChatSettingsIcon color={theme.colors.brand.primary} />,
      title: '对话设置',
      onPress: onChatSettings,
    },
  ];

  const primaryMenuItems = [
    ...(conversationId ? [{
      key: 'search-messages', icon: <View style={styles.iconBox}><Search size={22} color={theme.colors.brand.primary} /></View>,
      title: '搜索聊天记录', onPress: onSearchMessages,
    }] : []),
    {
      key: 'protocol-space',
      icon: <ProtocolIcon color={theme.colors.brand.primary} />,
      title: '协议空间',
      onPress: onProtocolSpace,
    },
    ...(conversationId ? [{
      key: 'chat-summary', icon: <SummaryIcon color={theme.colors.brand.primary} />,
      title: '聊天摘要', onPress: onChatSummary,
    }] : []),
    {
      key: 'call-history', icon: <CallHistoryIcon color={theme.colors.brand.primary} />,
      title: '通话记录', onPress: onCallHistory,
    },
    ...(conversationId ? [{
      key: 'chat-statistics', icon: <StatisticsIcon color={theme.colors.brand.primary} />,
      title: '相遇痕迹', onPress: onChatStatistics,
    }] : []),
    {
      key: 'clear-history',
      icon: <ClearHistoryIcon color={theme.colors.brand.primary} />,
      title: '清除聊天记录',
      onPress: handleClearHistory,
    },
  ];

  const dangerMenuItems = [
    {
      key: 'delete-ai',
      title: '删除当前 AI',
      onPress: handleDeleteAI,
      danger: true,
      center: true,
    },
  ];

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <NavigationHeader title="更多" onGoBack={onBack} />

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        <ThemedSurface variant="card" style={styles.aiInfoCard}>
          <Pressable accessibilityRole="button" accessibilityLabel="打开 AI 个人主页"
            accessibilityHint="进入主页后可编辑资料与人设" onPress={onOpenProfile}>
            <AIInfoCard
              name={aiAssistant?.name || 'AI助手'}
              model={aiAssistant?.model || '默认模型'}
              avatarUrl={aiAssistant?.avatar}
            />
          </Pressable>
        </ThemedSurface>
        <MenuSection items={settingsMenuItems} styles={styles} />
        <MenuSection items={primaryMenuItems} styles={styles} />
        <MenuSection items={dangerMenuItems} styles={styles} />
      </ScrollView>
    </SafeAreaView>
  );
}
