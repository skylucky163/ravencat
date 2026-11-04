import React, { useCallback } from 'react';
import { ConfiguredModelPicker } from '@shared/ui';
import { getAssistantVoiceModelSettings, selectAssistantVoiceModel, subscribeAssistantVoiceModelsChanged } from '../../application/AssistantVoiceModels';

export function AssistantVoiceModelPicker({ assistantId }: { assistantId: string }) {
  const getSettings = useCallback(() => getAssistantVoiceModelSettings(assistantId), [assistantId]);
  const onSelect = useCallback((id: string | null) => selectAssistantVoiceModel(assistantId, id), [assistantId]);
  return <ConfiguredModelPicker title="角色语音模型"
    getSettings={getSettings} onSelect={onSelect} subscribeChanged={subscribeAssistantVoiceModelsChanged} />;
}
