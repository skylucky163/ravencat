/** 可调用性与合法草稿不同：资产允许保存未填完的凭据，选择时统一判定是否可用。 */
import type { AuxiliaryModelConfig, CapabilityKind } from './domain/AuxiliaryModel';
import { validateSpeechConfiguration } from '@features/speech';
import { validateTranslationModelConfig } from '@features/integrations';

export function getAuxiliaryModelUnavailableReason(config: AuxiliaryModelConfig | null, kind: CapabilityKind): string | null {
  if (!config) return '模型已删除';
  if (config.capabilityKind !== kind) return '模型类型不匹配';
  if (kind === 'translation') {
    const errors = validateTranslationModelConfig({ baseURL: config.baseUrl, apiKey: config.apiKey ?? '', model: config.model, metadataJson: config.metadataJson });
    return Object.values(errors)[0] ?? null;
  }
  if (!config.baseUrl.trim() || !config.apiKey?.trim() || !config.model.trim()) return '连接配置不完整';
  if (kind === 'stt' || kind === 'tts') {
    const errors = validateSpeechConfiguration(kind, { baseURL: config.baseUrl, apiKey: config.apiKey!, model: config.model, metadataJson: config.metadataJson });
    const error = Object.values(errors)[0];
    if (error) return error;
  }
  return null;
}
