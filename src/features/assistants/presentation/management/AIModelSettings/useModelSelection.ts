// 模型列表获取与模型选择逻辑

import { useState, useEffect, useCallback, useRef } from 'react';
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
  const revision = useRef(0);
  const resetModelSelection = useCallback(() => {
    revision.current++;
    setAvailableModels([]);
    setShowModelPicker(false);
    setIsLoadingModels(false);
  }, []);

  useEffect(() => {
    resetModelSelection();
  }, [resetKey, apiBaseUrl, apiKey, resetModelSelection]);

  const handleFetchModels = useCallback(async () => {
    if (!apiBaseUrl || !apiKey) {
      return;
    }

    setIsLoadingModels(true);
    const requestRevision = ++revision.current;

    try {
      const { models, errorInfo } = await fetchModelsWithConfig({
        apiBaseUrl,
        apiKey,
      });
      // 地址相同也可能有不同模型权限；切换 Key 后不接收旧请求的列表。
      if (requestRevision !== revision.current) return;

      if (errorInfo) {
        console.log('[ModelSettings] Fetch models failed:', (errorInfo as { message?: string }).message);
        return;
      }

      setAvailableModels(models);

      if (models.length > 0) {
        setShowModelPicker(true);
      }
    } finally {
      if (requestRevision === revision.current) setIsLoadingModels(false);
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
