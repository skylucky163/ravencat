import React, { useCallback } from 'react';
import { ConfiguredModelPicker } from '@shared/ui';
import { getChatImageModelSettings, selectChatImageModel, subscribeChatImageModelsChanged } from '../../reply/application/ChatImageModels';

export function ChatImageModelPicker({ assistantId }: { assistantId: string }) {
  const getSettings = useCallback(() => getChatImageModelSettings(assistantId), [assistantId]);
  const onSelect = useCallback((id: string | null) => selectChatImageModel(assistantId, id), [assistantId]);
  return <ConfiguredModelPicker title="视觉识别模型"
    unconfiguredLabel="直接传图给聊天模型" clearSelectionLabel="直接传图（不使用视觉识别模型）"
    getSettings={getSettings} onSelect={onSelect}
    subscribeChanged={subscribeChatImageModelsChanged} />;
}
