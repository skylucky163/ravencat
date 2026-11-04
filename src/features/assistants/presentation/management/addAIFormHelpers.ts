// AddAIScreen 表单校验与保存辅助函数

import { createAIProfile, type AIProfile } from '../../domain/AIProfile';

export const DEFAULT_MAX_TOKENS = 2000;

export function getTrimmedAPIConfig({ apiBaseUrl, apiKey }: { apiBaseUrl: string; apiKey: string }) {
  return {
    apiBaseUrl: apiBaseUrl.trim(),
    apiKey: apiKey.trim(),
  };
}

export function getAddAIFormError({ name, apiBaseUrl, apiKey, selectedModel }: { name: string; apiBaseUrl: string; apiKey: string; selectedModel: string }): string | null {
  if (!name.trim()) return '请填写 AI 名称。';
  if (!apiBaseUrl.trim()) return '请填写 API 地址。';
  if (!apiKey.trim()) return '请填写 API Key。';
  if (!selectedModel) return '请选择模型。';
  return null;
}

export function getCurrentAddAIStep({ apiBaseUrl, apiKey, selectedModel }: { apiBaseUrl: string; apiKey: string; selectedModel: string }) {
  if (!apiBaseUrl.trim() || !apiKey.trim()) {
    return 1;
  }

  if (!selectedModel) {
    return 2;
  }

  return 3;
}

export function buildNewAI({
  serviceConfigId,
  name,
  selectedModel,
  apiKey,
  apiBaseUrl,
  systemPrompt,
}: {
  name: string;
  selectedModel: string;
  apiKey: string;
  apiBaseUrl: string;
  systemPrompt: string;
  serviceConfigId?: string | null;
}): AIProfile {
  const id = `ai_${Date.now()}`;
  return createAIProfile({
    id,
    serviceConfigId,
    agentId: `agent_${id}`,
    name: name.trim(),
    avatar: null,
    model: selectedModel,
    apiKey: apiKey.trim(),
    apiBaseUrl: apiBaseUrl.trim(),
    systemPrompt: systemPrompt.trim() || null,
    maxTokens: DEFAULT_MAX_TOKENS,
    enableTools: false,
    allowMultipleBubbles: true,
  });
}
