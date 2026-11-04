/** 管理员配置自动保存；草稿校验与持久化确认分开，错误保留在字段旁。 */
import { useState, useMemo } from 'react';
import { useAutoSaveDraft, useAutoSaveNavigation } from '@shared/ui/useAutoSaveDraft';
import { useAutoSaveFeedback } from '@shared/ui/useAutoSaveFeedback';
import { readDraftNumber } from '@shared/ui/draftValidation';
import type { GroupChatAdminConfig, UpdateGroupChatAdminConfigInput } from '../../group/domain/GroupChat';
import { fetchModelsWithConfig, runConnectionTestByConfig, type ModelInfo } from '@features/assistants';
import { getGroupAdminSettingsDraft, parseGroupAdminSettingsDraft, type GroupAdminSettingsDraft } from './groupAdminSettingsDraft';

export default function useGroupAdminSettings({ adminConfig, onUpdate, onBack }: {
  adminConfig?: GroupChatAdminConfig | null;
  onUpdate(input: UpdateGroupChatAdminConfigInput): Promise<void>;
  onBack?: () => void;
}) {
  const initial = useMemo(() => getGroupAdminSettingsDraft(adminConfig), [adminConfig]);
  const editor = useAutoSaveDraft({ initial, parse: parseGroupAdminSettingsDraft, save: onUpdate });
  const { draft, change, flush, restore, getSnapshot, errors, validateAll } = editor;
  const feedback = useAutoSaveFeedback(errors);
  const { back } = useAutoSaveNavigation(flush, () => onBack?.(), () => feedback.revealErrors(getSnapshot().errors));
  const restoreDraft = async () => { await restore(); feedback.setBlocked(false); };
  const setField = <K extends keyof GroupAdminSettingsDraft>(key: K, value: string, immediate = false) => change({ [key]: value } as Pick<GroupAdminSettingsDraft, K>, immediate);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<'success' | 'error' | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  const handleFetchModels = async () => {
    if (!draft.apiBaseUrl.trim() || !draft.apiKey.trim()) {
      setConnectionError('请先填写 API 地址和 API Key。');
      return;
    }
    setIsLoadingModels(true);
    setConnectionError(null);
    try {
      const result = await fetchModelsWithConfig({ apiBaseUrl: draft.apiBaseUrl.trim(), apiKey: draft.apiKey.trim() });
      if (result.errorInfo) { setConnectionError(result.errorInfo.message); return; }
      setAvailableModels(result.models);
      if (result.models.length > 0) setShowModelPicker(true);
    } finally { setIsLoadingModels(false); }
  };
  const handleSelectModel = (modelId: string) => {
    setField('selectedModel', modelId, true);
    setShowModelPicker(false);
    setTestResult(null);
    setConnectionError(null);
  };
  const handleTestConnection = async () => {
    const parsed = validateAll();
    if (!parsed) { feedback.revealErrors(getSnapshot().errors); return; }
    if (!draft.apiBaseUrl.trim() || !draft.apiKey.trim()) {
      setConnectionError('请先填写 API 地址和 API Key。');
      return;
    }
    setIsTesting(true);
    setTestResult(null);
    setConnectionError(null);
    try {
      const result = await runConnectionTestByConfig({
        apiBaseUrl: draft.apiBaseUrl.trim(), apiKey: draft.apiKey.trim(), selectedModel: draft.selectedModel.trim(),
        requestOptions: { temperature: parsed.temperature, topP: parsed.topP, maxTokens: parsed.maxTokens },
      });
      setTestResult(result.success ? 'success' : 'error');
      setConnectionError(result.errorInfo ? result.errorInfo.message : null);
    } finally { setIsTesting(false); }
  };

  const temperatureInput = readDraftNumber(draft.tempInput, 'Temperature', 0, 2, true);
  const topPInput = readDraftNumber(draft.topPInput, 'Top P', 0, 1, true);
  return {
    fillServiceConnection: (service: { id: string; baseUrl: string; apiKey: string }) => {
      change({ serviceConfigId: service.id, apiBaseUrl: service.baseUrl, apiKey: service.apiKey }, true);
      setAvailableModels([]); setShowModelPicker(false); setTestResult(null); setConnectionError(null);
    },
    ...draft, errors, saveError: editor.saveError, commit: editor.commit, flush, back, restoreDraft, feedback, connectionError,
    temperature: temperatureInput.error ? adminConfig?.temperature ?? null : temperatureInput.value,
    topP: topPInput.error ? adminConfig?.topP ?? null : topPInput.value,
    setApiBaseUrl: (value: string) => change({ apiBaseUrl: value, serviceConfigId: '' }),
    setApiKey: (value: string) => change({ apiKey: value, serviceConfigId: '' }),
    setSystemPrompt: (value: string) => setField('systemPrompt', value),
    handleTempChange: (value: string, immediate = false) => setField('tempInput', value, immediate),
    handleTopPChange: (value: string, immediate = false) => setField('topPInput', value, immediate),
    handleMaxTokensChange: (value: string, immediate = false) => setField('maxTokens', value, immediate),
    handleContextMessageCountChange: (value: string, immediate = false) => setField('contextMessageCount', value, immediate),
    availableModels, isLoadingModels, showModelPicker, setShowModelPicker, isTesting, testResult,
    handleFetchModels, handleSelectModel, handleTestConnection,
  };
}
