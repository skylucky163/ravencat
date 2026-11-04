/** 角色模型表单只提交模型字段增量；持久化确认不回填当前草稿。 */
import { useCallback, useMemo } from 'react';
import type { AIProfile } from '../../../domain/AIProfile';
import { updateAIModelSettings } from '../../../AIAssistantManagement';
import { useAutoSaveDraft } from '@shared/ui/useAutoSaveDraft';
import { readDraftNumber } from '@shared/ui/draftValidation';
import {
  DEFAULT_MAX_TOKENS,
  getModelSettingsDraft, parseModelSettingsDraft,
  type ModelSettingsDraft,
} from './modelSettingsHelpers';

export default function useModelSettingsForm({ aiAssistant, onUpdated }: {
  aiAssistant: AIProfile;
  onUpdated?: (ai: Partial<AIProfile>) => void;
}) {
  const initial = useMemo(() => getModelSettingsDraft(aiAssistant), [aiAssistant]);
  const editor = useAutoSaveDraft({
    initial, parse: parseModelSettingsDraft,
    save: async (patch) => {
      const persisted = await updateAIModelSettings(aiAssistant.id, patch);
      // 页面投影也只确认本次拥有的字段，不能把异步读取的无关旧状态填回宿主。
      const confirmed = Object.fromEntries(Object.keys(patch).map((key) => [key, persisted[key as keyof AIProfile]]));
      onUpdated?.({ ...confirmed, updatedAt: persisted.updatedAt });
    },
  });
  const { draft, change } = editor;
  const setField = useCallback(<K extends keyof ModelSettingsDraft>(key: K, value: ModelSettingsDraft[K], immediate = false) => {
    change({ [key]: value } as Pick<ModelSettingsDraft, K>, immediate);
  }, [change]);
  const temperatureInput = readDraftNumber(draft.tempInput, 'Temperature', 0, 2, true);
  const topPInput = readDraftNumber(draft.topPInput, 'Top P', 0, 1, true);
  const getConnectionParams = useCallback(() => ({
    temperature: temperatureInput.value,
    topP: topPInput.value,
    maxTokens: draft.maxTokens === '无限制' ? null : Number(draft.maxTokens),
    disableThinking: draft.disableThinking,
  }), [temperatureInput.value, topPInput.value, draft.maxTokens, draft.disableThinking]);
  return {
    ...editor, ...draft,
    // 无效草稿保留原输入，滑杆只接受已保存的合法投影。
    temperature: temperatureInput.error ? aiAssistant.temperature : temperatureInput.value,
    topP: topPInput.error ? aiAssistant.topP : topPInput.value,
    setApiBaseUrl: (value: string) => change({ apiBaseUrl: value, serviceConfigId: '' }),
    setApiKey: (value: string) => change({ apiKey: value, serviceConfigId: '' }),
    setSelectedModel: (value: string) => setField('selectedModel', value, true),
    setEnableTools: (value: boolean) => setField('enableTools', value, true),
    setDisableThinking: (value: boolean) => setField('disableThinking', value, true),
    handleTempChange: (value: string, immediate = false) => setField('tempInput', value, immediate),
    handleTopPChange: (value: string, immediate = false) => setField('topPInput', value, immediate),
    handleMaxTokensChange: (value: string, immediate = false) => setField('maxTokens', value, immediate),
    getConnectionParams,
    fillServiceConnection: (service: { id: string; baseUrl: string; apiKey: string }) => change({ serviceConfigId: service.id, apiBaseUrl: service.baseUrl, apiKey: service.apiKey }, true),
    handleReset: () => change({ tempInput: '', topPInput: '', maxTokens: String(DEFAULT_MAX_TOKENS) }, true),
  };
}
