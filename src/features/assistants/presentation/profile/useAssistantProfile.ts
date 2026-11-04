/** 个人主页资料按字段自动保存，头像媒体继续由原有草稿拥有。 */

import { showAppDialog } from '@shared/ui';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useAutoSaveDraft } from '@shared/ui/useAutoSaveDraft';
import { getAssistantProfileDraft, parseAssistantProfileDraft } from './assistantProfileDraft';

import type { AIProfile } from '../../domain/AIProfile';
import {
  getAIAssistantById,
  updateAIAssistantAvatarFromDraft,
  updateAIAssistantSettings,
} from '../../AIAssistantManagement';
import {
  PERSISTENT_IMAGE_CATEGORY,
  usePersistentAvatarDraft,
} from '@platform/device/DeviceMediaService';

interface UseAssistantProfileParams {
  aiAssistant: AIProfile;
}

export default function useAssistantProfile({
  aiAssistant,
}: UseAssistantProfileParams) {
  const [blocked, setBlocked] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarDirty = useRef(false);
  const avatarOperation = useRef<Promise<void> | null>(null);
  const initialInfo = useMemo(() => getAssistantProfileDraft(aiAssistant), [aiAssistant]);
  const infoEditor = useAutoSaveDraft({
    initial: initialInfo,
    parse: parseAssistantProfileDraft,
    save: async (patch) => {
      const updated = await updateAIAssistantSettings(aiAssistant.id, patch);
      if (!updated) throw new Error('AI 助手不存在');
    },
  });
  const { flush: flushInfo, restore: restoreInfoDraft } = infoEditor;
  const {
    avatarUri: avatarUrl, isPickingAvatar, isCommittingAvatar,
    pickAvatar, resetAvatar, discardAvatarDraft, commitAvatar,
  } = usePersistentAvatarDraft({
    category: PERSISTENT_IMAGE_CATEGORY.aiAvatar,
    entityId: aiAssistant.id,
    committedUri: aiAssistant.avatar,
  });

  const saveAvatar = useCallback(async () => {
    await commitAvatar(async (uri, draft) => {
      if (draft) return updateAIAssistantAvatarFromDraft(aiAssistant.id, draft);
      const updated = await updateAIAssistantSettings(aiAssistant.id, { avatar: uri, avatarMediaAssetId: null });
      if (!updated) throw new Error('AI 助手不存在');
      const assistant = await getAIAssistantById(aiAssistant.id);
      if (!assistant) throw new Error('保存后的 AI 助手不存在');
      return assistant;
    }, (assistant) => assistant.avatar);
    avatarDirty.current = false;
    setAvatarError(null);
  }, [aiAssistant.id, commitAvatar]);

  // 文件草稿由头像 hook 持有，失败时不丢弃；页面返回等待选择及提交结束。
  const runAvatarOperation = useCallback((operation: () => Promise<void>) => {
    if (avatarOperation.current) return avatarOperation.current;
    const pending = operation().catch((error: unknown) => {
      console.error('[AI 个人主页] 头像操作失败', error);
      setAvatarError('头像修改未能完成，已选择的图片会保留，请重试。');
    }).finally(() => { avatarOperation.current = null; });
    avatarOperation.current = pending;
    return pending;
  }, []);

  const handlePickAvatar = useCallback(() => runAvatarOperation(async () => {
    const result = await pickAvatar();
    if (result.status === 'permission-denied') {
      showAppDialog({ title: '需要权限', message: '请允许访问相册以选择头像', tone: 'warning' });
      return;
    }
    if (result.status !== 'selected') return;
    avatarDirty.current = true;
    await saveAvatar();
  }), [pickAvatar, runAvatarOperation, saveAvatar]);

  const handleResetAvatar = useCallback(() => {
    showAppDialog({ title: '恢复默认头像', message: '确定要移除当前自定义头像吗？', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '恢复默认', onPress: () => void runAvatarOperation(async () => {
        if (!await resetAvatar()) return;
        avatarDirty.current = true;
        await saveAvatar();
      }) },
    ] });
  }, [resetAvatar, runAvatarOperation, saveAvatar]);

  const handleAvatarPress = useCallback(() => {
    if (isPickingAvatar || isCommittingAvatar) return;
    showAppDialog({ title: 'AI 头像', message: '你可以为这个 AI 更换头像，或恢复默认头像。', buttons: [
      { text: '取消', style: 'cancel' },
      { text: '恢复默认', onPress: handleResetAvatar },
      { text: '从相册选择', onPress: () => void handlePickAvatar() },
    ] });
  }, [handlePickAvatar, handleResetAvatar, isPickingAvatar, isCommittingAvatar]);

  const flush = useCallback(async () => {
    if (avatarOperation.current) await avatarOperation.current;
    const infoSaved = await flushInfo();
    const saved = infoSaved && avatarOperation.current === null && !avatarDirty.current;
    setBlocked(!saved);
    return saved;
  }, [flushInfo]);
  const restoreInfo = useCallback(async () => {
    await restoreInfoDraft();
    setBlocked(false);
  }, [restoreInfoDraft]);
  const restoreAvatar = useCallback(async () => {
    if (avatarOperation.current) await avatarOperation.current;
    await runAvatarOperation(async () => {
      await discardAvatarDraft();
      avatarDirty.current = false;
      setAvatarError(null);
    });
  }, [discardAvatarDraft, runAvatarOperation]);
  const retryAvatar = useCallback(() => {
    if (avatarDirty.current) void runAvatarOperation(saveAvatar);
    else void handlePickAvatar();
  }, [handlePickAvatar, runAvatarOperation, saveAvatar]);

  return {
    name: infoEditor.draft.name,
    setName: (name: string) => infoEditor.change({ name }),
    nickname: infoEditor.draft.nickname,
    setNickname: (nickname: string) => infoEditor.change({ nickname }),
    nicknameError: infoEditor.errors.nickname,
    systemPrompt: infoEditor.draft.systemPrompt,
    setSystemPrompt: (systemPrompt: string) => infoEditor.change({ systemPrompt }),
    nameError: infoEditor.errors.name,
    infoSaveError: infoEditor.saveError,
    avatarError, blocked, commit: infoEditor.commit, flush, restoreInfo, restoreAvatar, retryAvatar,
    avatarUrl,
    dirty: infoEditor.dirty || isPickingAvatar || isCommittingAvatar || avatarDirty.current,
    handleAvatarPress,
  };
}
