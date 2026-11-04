/** 回复显示自动保存，背景组件保持各自的提交流程。 */
// 对话设置页面 - 主组件（组装层）

import React from 'react';
import {
  Text,
  ScrollView,
  Pressable,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import NavigationHeader from '@shared/ui/NavigationHeader';
import { BackgroundPickerCard, KeyboardAvoidingContainer, ToggleField } from '@shared/ui';
import { AutoSaveErrors } from '@shared/ui/AutoSaveErrors';
import useChatSettings from './useChatSettings';
import { createStyles } from './chatSettingsStyles';
import { getChatInteractionProfile, ThemedSurface, useTheme, useThemedStyles } from '@shared/theme';
import { createCommonStyles } from '@shared/ui/commonStyles';
import type { AIProfile } from '@features/assistants';
import { ChevronRight } from 'lucide-react-native';
import ChatWallpaperSettings from '../messages/components/ChatWallpaperSettings';
import { CallRingtoneSettings } from '@features/calls';

interface ChatSettingsProps {
  aiAssistant: AIProfile;
  onOpenContextSettings(): void;
  chatBackgroundKey?: string | null;
  onBack?: (updatedAI?: Partial<AIProfile>) => void;
  onUpdated?: (updatedAI: Partial<AIProfile>) => void;
}

/**
 * 对话设置页面主组件
 * @param aiAssistant - 当前 AI 助手数据
 * @param onBack - 返回回调
 * @param onUpdated - 更新成功回调
 */
export default function ChatSettings({ aiAssistant, onOpenContextSettings, chatBackgroundKey, onBack, onUpdated }: ChatSettingsProps) {
  const theme = useTheme();
  const interactionProfile = getChatInteractionProfile(theme);
  const canUseMultipleBubbles = interactionProfile.enableAssistantMessageSegmentation;
  const styles = useThemedStyles(createStyles);
  const commonStyles = React.useMemo(() => createCommonStyles(theme), [theme]);

  const {
    allowMultipleBubbles,
    setAllowMultipleBubbles,
    streamingReply,
    setStreamingReply,
    showTokenUsage,
    setShowTokenUsage,
    showActionSteps,
    setShowActionSteps,
    settingsErrors,
    callBackgroundUri,

    // 状态
    isLoading,

    // 背景操作
    handlePickCallBackground,
    handleClearCallBackground,
    infoSaveError, blocked, flush, back, leave, restoreInfo,
  } = useChatSettings({ aiAssistant, onBack, onUpdated });

  return (
    <SafeAreaView style={commonStyles.screenContainer} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingContainer style={commonStyles.screenContainer}>
        <NavigationHeader title="对话设置" onGoBack={back} />

        <ScrollView style={commonStyles.screenContainer} showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <ThemedSurface variant="card" style={styles.entryCard}>
            <Pressable accessibilityRole="button" accessibilityLabel="上下文设置" style={styles.entryRow}
              onPress={() => { void leave(onOpenContextSettings); }}>
              <View style={styles.rowCopy}>
                <Text style={styles.rowTitle}>上下文设置</Text>
                <Text style={styles.rowDescription}>按条数注入、固定消息起点与历史群聊</Text>
              </View>
              <ChevronRight size={18} color={theme.colors.text.tertiary} />
            </Pressable>
          </ThemedSurface>

          {/* 气泡数量只影响客户端自动分段，不改变聊天输出格式要求。 */}
          <Text style={styles.sectionLabel}>回复显示</Text>
          <ThemedSurface variant="card" style={styles.toggleCard}>
            <ToggleField
              layout="inline"
              style={styles.toggleRow}
              label="流式输出"
              hint="边生成边显示 · 下一轮回复生效"
              value={streamingReply ?? interactionProfile.preferStreamingReply}
              onValueChange={setStreamingReply}
            />
            <ToggleField
              layout="inline"
              style={styles.toggleRow}
              label="允许多气泡回复"
              hint={canUseMultipleBubbles
                ? '按自然段落拆分，可与流式同时开启'
                : '当前主题使用单气泡，仍会保留此选择'}
              value={allowMultipleBubbles}
              onValueChange={setAllowMultipleBubbles}
            />
            <ToggleField
              layout="inline"
              style={styles.toggleRow}
              label="显示行动步骤"
              hint="查看思考与工具执行过程"
              value={showActionSteps}
              onValueChange={setShowActionSteps}
            />
            <ToggleField
              layout="inline"
              style={styles.lastToggleRow}
              label="显示 Token 用量"
              hint="在回复下方查看消耗与缓存命中"
              value={showTokenUsage}
              onValueChange={setShowTokenUsage}
            />
          </ThemedSurface>
          <AutoSaveErrors error={infoSaveError} blocked={blocked && Object.keys(settingsErrors).length > 0}
            retry={() => void flush()} restore={() => void restoreInfo()} />

          <Text style={styles.sectionLabel}>背景</Text>
          <ChatWallpaperSettings chatKey={chatBackgroundKey} style={styles.backgroundCard} />

          {/* 通话背景 */}
          <BackgroundPickerCard
            style={styles.backgroundCard}
            title="通话背景"
            description="这位 AI 的专属通话背景"
            previewSource={callBackgroundUri ? { uri: callBackgroundUri } : null}
            previewFallbackColor={theme.colors.chat.screen}
            previewTitle={callBackgroundUri ? '自定义通话背景' : '默认通话背景'}
            previewSubtitle={callBackgroundUri ? '已选择自定义图片' : '使用系统默认背景'}
            isPicking={isLoading}
            resetDimmed={!callBackgroundUri}
            onPick={handlePickCallBackground}
            onReset={handleClearCallBackground}
          />
          <Text style={styles.sectionLabel}>通话铃声</Text>
          <CallRingtoneSettings assistantId={aiAssistant.id} />
        </ScrollView>
      </KeyboardAvoidingContainer>
    </SafeAreaView>
  );
}
