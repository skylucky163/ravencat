/** 设置与正文列表分开；离开设置页先确认草稿，模型执行不占用页面 busy。 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { KeyboardAvoidingContainer, NavigationHeader, ConfiguredModelPicker } from '@shared/ui';
import { aiAssistantRepository, getAuxiliaryModelSelection, requireAuxiliaryModel, subscribeAuxiliaryModelsChanged } from '@features/assistants';
import { useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useTheme, useThemedStyles } from '@shared/theme';
import { estimateTextTokens } from '@shared/prompt';
import { getChatSummarySettings, updateChatSummarySettings } from '../application/ChatSummary';
import { subscribeChatSummaryChanged } from '../application/ChatSummaryRuntime';
import type { ChatSummarySettingsPatch } from '../domain/ChatSummaryRepository';
import ChatSummarySettingsPanel, { type ChatSummarySettingsEditor } from './ChatSummarySettingsPanel';
import { useChatSummarySnapshot } from './useChatSummarySnapshot';
import { createChatSummaryStyles } from './chatSummaryStyles';

export default function ChatSummarySettingsScreen({ conversationId, onBack, group = false, assistantId }: { conversationId: string; onBack(): void; group?: boolean; assistantId?: string }) {
  const theme = useTheme(), styles = useThemedStyles(createChatSummaryStyles);
  const { snapshot, error } = useChatSummarySnapshot(conversationId);
  const editor = useRef<ChatSummarySettingsEditor>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [followPrimaryLimit, setFollowPrimaryLimit] = useState<number | null>(null);
  // 跟随值只是展示；真正解析在领取时按当时的单聊消息注入条数读取，无需订阅同步。
  useEffect(() => {
    if (group || !assistantId) return;
    let alive = true;
    void aiAssistantRepository.getById(assistantId).then((assistant) => {
      if (alive && assistant) setFollowPrimaryLimit(assistant.privateContextPrimaryLimit);
    });
    return () => { alive = false; };
  }, [group, assistantId, snapshot?.settings.primaryLimit]);
  const getModels = useCallback(async () => getAuxiliaryModelSelection({
    modelConfigId: (await getChatSummarySettings(conversationId)).modelConfigId, capabilityKind: 'summary',
  }), [conversationId]);
  const subscribeModels = useCallback((listener: () => void) => {
    const models = subscribeAuxiliaryModelsChanged(listener);
    const summary = subscribeChatSummaryChanged((id) => { if (id === conversationId) listener(); });
    return () => { models(); summary(); };
  }, [conversationId]);
  const selectModel = useCallback(async (modelConfigId: string | null) => {
    if (modelConfigId !== null) await requireAuxiliaryModel(modelConfigId, 'summary');
    await updateChatSummarySettings(conversationId, { modelConfigId });
  }, [conversationId]);
  const { back } = useAutoSaveNavigation(async () => !snapshot || await editor.current!.flush(), onBack, () => setBlocked(true));
  const save = async (patch: ChatSummarySettingsPatch) => {
    setBusy(true);
    try { await updateChatSummarySettings(conversationId, patch); setBlocked(false); }
    finally { setBusy(false); }
  };
  return <SafeAreaView style={styles.screen}><KeyboardAvoidingContainer style={styles.screen}>
    <NavigationHeader title="摘要设置" onGoBack={back} help={{ sections: [
      { title: '摘要模型', body: '一级、二级共用同一个选择。摘要模型持续引用该配置，停用或删除后暂停任务并保留选择；切换模型保留正文和进度，未选择时跟随当前聊天模型。' },
      { title: '条数与阈值', body: group
        ? '群触发条数全群共用，独立于各成员的消息注入条数和调度窗口，达到门槛后按群处理进度生成。'
        : '每次整理条数留空跟随该 AI 的当前单聊消息注入条数，改那里的数值会同步变化；手动填写后固定为填写值，不再跟随。' },
      { title: '请求与保存', body: '最长等待与输出 token 上限只影响本会话摘要，不改变普通聊天；输出留空跟随实际总结模型。输入框离开时自动保存。' },
      { title: '摘要结构', body: '一级与二级摘要独立维护，编辑或删除不会自动同步另一层。待归纳 token 按正文估算，领取时包含刚新增的一批，成功后才替换上下文。关闭注入后仍可查看和主动查询摘要。' },
    ] }} />
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      {error && <Text style={styles.danger}>{error}</Text>}
      {blocked && <Text style={styles.danger}>请先修正或恢复尚未保存的输入。</Text>}
      {!snapshot && !error && <ActivityIndicator color={theme.colors.brand.primary} />}
      {snapshot && <ConfiguredModelPicker title="摘要模型"
        unconfiguredLabel={group ? '群聊管理员' : '当前聊天模型'} clearSelectionLabel={group ? '使用群聊管理员' : '使用当前聊天模型'}
        getSettings={getModels} onSelect={selectModel} subscribeChanged={subscribeModels} />}
      {snapshot && <ChatSummarySettingsPanel ref={editor} settings={snapshot.settings} busy={busy} onSave={save} group={group}
        followPrimaryLimit={followPrimaryLimit}
        pendingTokens={snapshot.segments.filter((segment) => segment.level === 'primary' && segment.compactionId === null).reduce((sum, segment) => sum + estimateTextTokens(segment.content), 0)} />}
    </ScrollView>
  </KeyboardAvoidingContainer></SafeAreaView>;
}
