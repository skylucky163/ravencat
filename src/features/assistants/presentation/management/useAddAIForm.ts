// AddAIScreen 组装层 Hook

import { useCallback } from 'react';
import useAddAIFormState from './useAddAIFormState';
import useAddAIModelSelection, { ModelItem } from './useAddAIModelSelection';
import useAddAIConnectionTest from './useAddAIConnectionTest';
import { getTrimmedAPIConfig } from './addAIFormHelpers';

interface UseAddAIFormOptions {
  onAdded?: () => void;
  onBack?: () => void;
}

interface UseAddAIFormResult {
  // 表单字段
  name: string;
  setName: (name: string) => void;
  apiKey: string;
  apiBaseUrl: string;
  selectedModel: string;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;

  // 状态
  availableModels: ModelItem[];
  isLoadingModels: boolean;
  showModelPicker: boolean;
  setShowModelPicker: (show: boolean) => void;
  isTesting: boolean;
  testResult: 'success' | 'error' | null;
  currentStep: number;

  // 处理方法
  handleApiBaseUrlChange: (text: string) => void;
  handleApiKeyChange: (text: string) => void;
  handleFetchModels: () => Promise<void>;
  handleSelectModel: (modelId: string) => void;
  handleTestConnection: () => Promise<void>;
  handleSave: () => Promise<void>;
  handleFillServiceConnection(service: { id: string; baseUrl: string; apiKey: string }): void;
}

/**
 * AddAIScreen 表单逻辑 Hook
 */
export default function useAddAIForm({ onAdded, onBack }: UseAddAIFormOptions): UseAddAIFormResult {
  const {
    name,
    setName,
    apiKey,
    setApiKey,
    apiBaseUrl,
    setApiBaseUrl,
    selectedModel,
    setSelectedModel,
    systemPrompt,
    setSystemPrompt,
    currentStep,
    handleSave, fillServiceConnection,
  } = useAddAIFormState({ onAdded, onBack });

  const trimmedConfig = getTrimmedAPIConfig({ apiBaseUrl, apiKey });

  const {
    availableModels,
    isLoadingModels,
    showModelPicker,
    setShowModelPicker,
    resetModelSelection,
    handleFetchModels: fetchModels,
    handleSelectModel: selectModel,
  } = useAddAIModelSelection({
    apiBaseUrl: trimmedConfig.apiBaseUrl,
    apiKey: trimmedConfig.apiKey,
    setSelectedModel,
  });

  const {
    isTesting,
    testResult,
    resetConnectionTest,
    handleTestConnection,
  } = useAddAIConnectionTest({
    apiBaseUrl: trimmedConfig.apiBaseUrl,
    apiKey: trimmedConfig.apiKey,
    selectedModel,
  });

  const resetModelFlow = useCallback(() => {
    setSelectedModel('');
    resetModelSelection();
    resetConnectionTest();
  }, [setSelectedModel, resetModelSelection, resetConnectionTest]);

  const handleApiBaseUrlChange = useCallback((text: string) => {
    setApiBaseUrl(text);
    resetModelFlow();
  }, [setApiBaseUrl, resetModelFlow]);

  const handleApiKeyChange = useCallback((text: string) => {
    setApiKey(text);
    resetModelFlow();
  }, [setApiKey, resetModelFlow]);

  const handleFetchModels = useCallback(async () => {
    resetConnectionTest();
    await fetchModels();
  }, [fetchModels, resetConnectionTest]);

  const handleSelectModel = useCallback((modelId: string) => {
    selectModel(modelId);
    resetConnectionTest();
  }, [selectModel, resetConnectionTest]);

  return {
    handleFillServiceConnection: service => { resetModelFlow(); fillServiceConnection(service); },
    // 表单字段
    name,
    setName,
    apiKey,
    apiBaseUrl,
    selectedModel,
    systemPrompt,
    setSystemPrompt,

    // 状态
    availableModels,
    isLoadingModels,
    showModelPicker,
    setShowModelPicker,
    isTesting,
    testResult,
    currentStep,

    // 处理方法
    handleApiBaseUrlChange,
    handleApiKeyChange,
    handleFetchModels,
    handleSelectModel,
    handleTestConnection,
    handleSave,
  };
}
