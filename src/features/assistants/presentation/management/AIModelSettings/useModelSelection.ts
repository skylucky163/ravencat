// 模型列表获取与模型选择逻辑

import { useState, useEffect, useCallback } from 'react';
import type { ModelInfo } from '../../../application/modelTypes';
import { fetchModelsWithConfig } from '../sharedModelConfig';

interface UseModelSelectionProps {
  apiBaseUrl: string;
  apiKey: string;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  resetKey: string;
}

interface UseModelSelectionReturn {
  selectedModel: string;
  availableModels: ModelInfo[];
  isLoadingModels: boolean;
  showModelPicker: boolean;
  setShowModelPicker: (value: boolean) => void;
  handleFetchModels: () => Promise<void>;
  handleSelectModel: (modelId: string) => void;
  resetModelSelection: () => void;
}

export default function useModelSelection({
  apiBaseUrl,
  apiKey,
  selectedModel,
  setSelectedModel,
  resetKey,
}: UseModelSelectionProps): UseModelSelectionReturn {
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const resetModelSelection = useCallback(() => {
    setAvailableModels([]);
    setShowModelPicker(false);
  }, []);

  useEffect(() => {
    resetModelSelection();
  }, [resetKey, resetModelSelection]);

  const handleFetchModels = useCallback(async () => {
    if (!apiBaseUrl || !apiKey) {
      return;
    }

    setIsLoadingModels(true);

    try {
      const { models, errorInfo } = await fetchModelsWithConfig({
        apiBaseUrl,
        apiKey,
      });

      if (errorInfo) {
        console.log('[ModelSettings] Fetch models failed:', (errorInfo as { message?: string }).message);
        return;
      }

      setAvailableModels(models);

      if (models.length > 0) {
        setShowModelPicker(true);
      }
    } finally {
      setIsLoadingModels(false);
    }
  }, [apiBaseUrl, apiKey]);

  const handleSelectModel = useCallback((modelId: string) => {
    setSelectedModel(modelId);
    setShowModelPicker(false);
  }, [setSelectedModel]);

  return {
    selectedModel,
    availableModels,
    isLoadingModels,
    showModelPicker,
    setShowModelPicker,
    handleFetchModels,
    handleSelectModel,
    resetModelSelection,
  };
}
