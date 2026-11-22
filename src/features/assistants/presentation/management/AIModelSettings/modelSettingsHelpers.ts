/** 角色模型输入边界：只转换实际修改字段，不生成整份 AIProfile。 */
import type { AIProfile } from '../../../domain/AIProfile';
import type { AIModelSettingsUpdate } from '../../../domain/AssistantRepository';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { readDraftInteger, readDraftNumber } from '@shared/ui/draftValidation';

export interface ConnectionParams { temperature: number | null; topP: number | null; maxTokens: number | null; disableThinking: boolean; reasoningEffort: import('@platform/ai').ReasoningEffort }
export interface ModelSettingsDraft {
  serviceConfigId: string;
  apiBaseUrl: string;
  apiKey: string;
  selectedModel: string;
  tempInput: string;
  topPInput: string;
  maxTokens: string;
  enableTools: boolean;
  disableThinking: boolean;
  reasoningEffort: import('@platform/ai').ReasoningEffort;
}
export function getModelSettingsDraft(ai: AIProfile): ModelSettingsDraft {
  return {
    serviceConfigId: ai.serviceConfigId ?? '',
    apiBaseUrl: ai.apiBaseUrl ?? '', apiKey: ai.apiKey ?? '', selectedModel: ai.model,
    tempInput: ai.temperature === null ? '' : String(ai.temperature),
    topPInput: ai.topP === null ? '' : String(ai.topP), maxTokens: ai.maxTokens === null ? '' : String(ai.maxTokens),
    enableTools: ai.enableTools, disableThinking: ai.disableThinking, reasoningEffort: ai.reasoningEffort,
  };
}
export function parseModelSettingsDraft(draft: ModelSettingsDraft, changed: (keyof ModelSettingsDraft)[]): DraftCommit<ModelSettingsDraft, AIModelSettingsUpdate> {
  const patch: AIModelSettingsUpdate = {};
  const accepted: (keyof ModelSettingsDraft)[] = [];
  const errors: DraftErrors<ModelSettingsDraft> = {};
  const numeric = {
    tempInput: { field: 'temperature', label: 'Temperature', min: 0, max: 2 },
    topPInput: { field: 'topP', label: 'Top P', min: 0, max: 1 },
  } as const;
  for (const key of changed) {
    if (key === 'tempInput' || key === 'topPInput') {
      const spec = numeric[key];
      const parsed = readDraftNumber(draft[key], spec.label, spec.min, spec.max, true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch[spec.field] = parsed.value;
    } else if (key === 'maxTokens') {
      const parsed = readDraftInteger(draft.maxTokens, 'Max Tokens', true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch.maxTokens = parsed.value;
    } else if (key === 'serviceConfigId') {
      patch.serviceConfigId = draft.serviceConfigId || null;
    } else if (key === 'selectedModel') {
      patch.model = draft[key].trim();
    } else if (key === 'apiBaseUrl' || key === 'apiKey') {
      patch[key] = draft[key].trim();
    } else if (key === 'enableTools' || key === 'disableThinking') {
      patch[key] = draft[key];
    } else if (key === 'reasoningEffort') {
      patch.reasoningEffort = draft.reasoningEffort;
    }
    accepted.push(key);
  }
  return { patch, accepted, errors };
}
