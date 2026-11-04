/** 回复显示按字段自动保存，通话背景独立提交。 */

import { showAppDialog } from '@shared/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { getChatSettingsDraft, parseChatSettingsDraft } from './chatSettingsDraft';

import * as ImagePicker from 'expo-image-picker';

import type { AIProfile } from '@features/assistants';
import {
  updateAIAssistantSettings,
} from '@features/assistants';
import {
  clearCallBackground,
  loadCallBackgroundUri,
  setCustomCallBackground,
  subscribeCallBackgroundChanged,
} from '@features/calls';
import { pickCroppedImage } from '@platform/device/DeviceMediaService';

interface UseChatSettingsParams {
  aiAssistant: AIProfile;
  onBack?: (updatedAI?: Partial<AIProfile>) => void;
  onUpdated?: (updatedAI: Partial<AIProfile>) => void;
}

export default function useChatSettings({
  aiAssistant,
  onBack,
  onUpdated,
}: UseChatSettingsParams) {
  const [callBackgroundUri, setCallBackgroundUri] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const initialInfo = useMemo(() => getChatSettingsDraft(aiAssistant), [aiAssistant]);
  const infoEditor = useAutoSaveDraft({
    initial: initialInfo,
    parse: parseChatSettingsDraft,
    save: async (patch) => {
      const updated = await updateAIAssistantSettings(aiAssistant.id, patch);
      if (!updated) throw new Error('AI 助手不存在');
      onUpdated?.(patch);
    },
  });
  const { flush, restore: restoreInfoDraft } = infoEditor;
  const { back, leave } = useAutoSaveNavigation(flush, () => onBack?.(), () => setBlocked(true));
  const restoreInfo = useCallback(async () => {
    await restoreInfoDraft();
    setBlocked(false);
  }, [restoreInfoDraft]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    setCallBackgroundUri(null);
    const refresh = () => {
      const current = ++revision;
      void loadCallBackgroundUri(aiAssistant.id)
        .then((storedUri) => { if (active && current === revision) setCallBackgroundUri(storedUri); })
        .catch((error) => console.warn('[useChatSettings] Failed to load call background:', error));
    };
    const unsubscribe = subscribeCallBackgroundChanged(assistantId => { if (assistantId === aiAssistant.id) refresh(); });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, [aiAssistant.id]);

  const handlePickCallBackground = useCallback(async () => {
    try {
      setIsLoading(true);

      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        showAppDialog({ title: '需要权限', message: '请允许访问相册以选择通话背景', tone: 'warning' });
        return;
      }

      const asset = await pickCroppedImage({ aspect: 'screen' });
      if (!asset) return;

      await setCustomCallBackground({
        assistantId: aiAssistant.id,
        sourceUri: asset.uri,
        sourceWidth: asset.width ?? null,
      });
      showAppDialog({ title: '成功', message: '通话背景已更新', tone: 'success' });
    } catch (error) {
      console.error('Failed to pick call background:', error);
      showAppDialog({ title: '错误', message: '更换通话背景失败，请稍后重试', tone: 'error' });
    } finally {
      setIsLoading(false);
    }
  }, [aiAssistant.id]);

  const handleClearCallBackground = useCallback(() => {
    showAppDialog({ title: '恢复默认通话背景', message: '确定要移除这个 AI 的自定义通话背景吗？', buttons: [
      { text: '取消', style: 'cancel' },
      {
        text: '恢复默认',
        onPress: async () => {
          try {
            await clearCallBackground(aiAssistant.id);
            showAppDialog({ title: '成功', message: '已恢复默认通话背景', tone: 'success' });
          } catch (error) {
            console.error('Failed to clear call background:', error);
            showAppDialog({ title: '错误', message: '恢复默认通话背景失败', tone: 'error' });
          }
        },
      },
    ] });
  }, [aiAssistant.id]);

  return {
    settingsErrors: infoEditor.errors,
    allowMultipleBubbles: infoEditor.draft.allowMultipleBubbles,
    setAllowMultipleBubbles: (allowMultipleBubbles: boolean) => infoEditor.change({ allowMultipleBubbles }, true),
    streamingReply: infoEditor.draft.streamingReply,
    setStreamingReply: (streamingReply: boolean | null) => infoEditor.change({ streamingReply }, true),
    showTokenUsage: infoEditor.draft.showTokenUsage,
    setShowTokenUsage: (showTokenUsage: boolean) => infoEditor.change({ showTokenUsage }, true),
    showActionSteps: infoEditor.draft.showActionSteps,
    setShowActionSteps: (showActionSteps: boolean) => infoEditor.change({ showActionSteps }, true),
    infoSaveError: infoEditor.saveError,
    blocked, commit: infoEditor.commit, flush, back, leave, restoreInfo,
    callBackgroundUri,
    isLoading,
    handlePickCallBackground,
    handleClearCallBackground,
  };
}
