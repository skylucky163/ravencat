/** 翻译连接与提供方参数作为一组提交，避免切换提供方时混用旧凭据。 */
import { readTranslationMetadata, validateTranslationModelConfig, type TranslationModelConfig, type TranslationProvider } from '@features/integrations';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import type { AuxiliaryModelConfig, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';

export interface TranslationModelDraft {
  serviceConfigId: string;
  name: string; provider: TranslationProvider;
  baseUrl: string; apiKey: string; model: string;
  source: string; target: string; secretId: string; region: string; projectId: string;
}
const connectionKeys: (keyof TranslationModelDraft)[] = ['serviceConfigId', 'provider', 'baseUrl', 'apiKey', 'model', 'source', 'target', 'secretId', 'region', 'projectId'];
export function switchTranslationProvider(provider: TranslationProvider): Omit<TranslationModelDraft, 'name'> {
  return {
    serviceConfigId: '', provider, baseUrl: provider === 'aiModel' ? '' : 'https://tmt.tencentcloudapi.com',
    apiKey: '', model: provider === 'aiModel' ? '' : 'TextTranslate',
    source: 'auto', target: 'zh', secretId: '', region: 'ap-guangzhou', projectId: '0',
  };
}
export function getTranslationModelDraft(data: AuxiliaryModelConfig | null): TranslationModelDraft {
  if (!data) return { name: '', ...switchTranslationProvider('aiModel') };
  const metadata = readTranslationMetadata(data.metadataJson!);
  return {
    serviceConfigId: data.serviceConfigId ?? '', name: data.name, provider: metadata.provider,
    baseUrl: data.baseUrl, apiKey: data.apiKey ?? '', model: data.model,
    source: metadata.source, target: metadata.target,
    secretId: metadata.secretId ?? '', region: metadata.region ?? 'ap-guangzhou', projectId: String(metadata.projectId ?? 0),
  };
}
export function buildTranslationConfiguration(draft: TranslationModelDraft): TranslationModelConfig {
  return {
    baseURL: draft.baseUrl.trim(), apiKey: draft.apiKey.trim(), model: draft.model.trim(),
    temperature: null, topP: null, maxTokens: null,
    metadataJson: JSON.stringify({ provider: draft.provider, source: draft.source.trim(), target: draft.target.trim(),
      ...(draft.provider === 'tencentCloudTmt' ? { secretId: draft.secretId.trim(), region: draft.region.trim(), projectId: Number(draft.projectId) } : {}),
    }),
  };
}
export function parseTranslationModelDraft(draft: TranslationModelDraft, changed: (keyof TranslationModelDraft)[]): DraftCommit<TranslationModelDraft, UpdateAuxiliaryModelConfigInput> {
  const patch: UpdateAuxiliaryModelConfigInput = {};
  const errors: DraftErrors<TranslationModelDraft> = {};
  const accepted: (keyof TranslationModelDraft)[] = [];
  if (changed.includes('name')) {
    if (!draft.name.trim()) errors.name = '配置名称不能为空；这次修改尚未保存。';
    else { patch.name = draft.name.trim(); accepted.push('name'); }
  }
  const group = changed.filter((key) => connectionKeys.includes(key));
  if (group.length) {
    if (draft.provider === 'tencentCloudTmt' && (!draft.projectId.trim() || !Number.isSafeInteger(Number(draft.projectId)) || Number(draft.projectId) < 0)) {
      errors.projectId = '项目 ID 需要填写非负整数；这次修改尚未保存。';
    } else {
      const config = buildTranslationConfiguration(draft);
      Object.assign(errors, validateTranslationModelConfig(config));
      if (Object.keys(errors).every((key) => key === 'name')) {
        Object.assign(patch, { ...(changed.includes('serviceConfigId') ? { serviceConfigId: draft.serviceConfigId || null } : {}), baseUrl: config.baseURL, apiKey: config.apiKey, model: config.model, metadataJson: config.metadataJson });
        accepted.push(...group);
      }
    }
  }
  return { patch, accepted, errors };
}
