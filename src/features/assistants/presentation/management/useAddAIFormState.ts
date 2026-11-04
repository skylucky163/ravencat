// AddAIScreen 基础表单与保存逻辑

import { showAppDialog } from '@shared/ui';
import { useState, useCallback, useMemo } from 'react';

import { createAIAssistant } from '../../AIAssistantManagement';
import {
  buildNewAI,
  getAddAIFormError,
  getCurrentAddAIStep,
} from './addAIFormHelpers';

interface UseAddAIFormStateOptions {
  onAdded?: () => void;
  onBack?: () => void;
}

interface UseAddAIFormStateResult {
  name: string;
  setName: (name: string) => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  apiBaseUrl: string;
  setApiBaseUrl: (url: string) => void;
  selectedModel: string;
  setSelectedModel: (model: string) => void;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  currentStep: number;
  handleSave: () => Promise<void>;
  fillServiceConnection(service: { id: string; baseUrl: string; apiKey: string }): void;
}

export default function useAddAIFormState({ onAdded, onBack }: UseAddAIFormStateOptions): UseAddAIFormStateResult {
  const [serviceConfigId, setServiceConfigId] = useState('');
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const currentStep = useMemo(() => getCurrentAddAIStep({
    apiBaseUrl,
    apiKey,
    selectedModel,
  }), [apiBaseUrl, apiKey, selectedModel]);

  const handleSave = useCallback(async () => {
    const validationError = getAddAIFormError({
      name,
      apiBaseUrl,
      apiKey,
      selectedModel,
    });

    if (validationError) {
      showAppDialog({ title: '请补全信息', message: validationError, tone: 'warning' });
      return;
    }

    try {
      const newAI = buildNewAI({
        serviceConfigId: serviceConfigId || null,
        name,
        selectedModel,
        apiKey,
        apiBaseUrl,
        systemPrompt,
      });

      await createAIAssistant(newAI);
      onAdded?.();
      onBack?.();
    } catch (error) {
      console.error('Failed to add AI:', error.message);
      showAppDialog({ title: '添加失败', message: '无法保存 AI 助手，请稍后重试。', tone: 'error' });
    }
  }, [
    serviceConfigId,
    name,
    apiBaseUrl,
    apiKey,
    selectedModel,
    systemPrompt,
    onAdded,
    onBack,
  ]);

  return {
    fillServiceConnection: service => { setServiceConfigId(service.id); setApiBaseUrl(service.baseUrl); setApiKey(service.apiKey); },
    name,
    setName,
    apiKey,
    setApiKey: value => { setApiKey(value); setServiceConfigId(''); },
    apiBaseUrl,
    setApiBaseUrl: value => { setApiBaseUrl(value); setServiceConfigId(''); },
    selectedModel,
    setSelectedModel,
    systemPrompt,
    setSystemPrompt,
    currentStep,
    handleSave,
  };
}
