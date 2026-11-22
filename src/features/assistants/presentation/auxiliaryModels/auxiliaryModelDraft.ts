/** 辅助模型输入转换；各字段独立校验和更新。 */
import type { AuxiliaryModelConfig, CapabilityKind, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { readDraftNumber, readDraftInteger } from '@shared/ui/draftValidation';
import { getCustomImageBaseURLError, IMAGE_GENERATION_PROVIDERS, readImageGenerationProfile } from '@platform/ai/imageGenerationConfig';
export interface AuxiliaryModelDraft {
  serviceConfigId: string;
  name: string; baseUrl: string; apiKey: string; model: string;
  tempInput: string; topPInput: string; maxTokens: string;
  imageProvider: string;
}
export function getAuxiliaryModelDraft(data: AuxiliaryModelConfig | null): AuxiliaryModelDraft {
  const profile = readImageGenerationProfile(data?.capabilityKind === 'image_generation' ? data.metadataJson : null);
  return {
    imageProvider: profile?.provider ?? '',
    serviceConfigId: data?.serviceConfigId ?? '',
    name: data?.name ?? '',
    baseUrl: data?.baseUrl ?? '',
    apiKey: data?.apiKey ?? '', model: data?.model ?? '',
    tempInput: data?.temperature == null ? '' : String(data.temperature),
    topPInput: data?.topP == null ? '' : String(data.topP), maxTokens: data?.maxTokens == null ? '' : String(data.maxTokens),
  };
}
export function parseAuxiliaryModelDraft(kind: CapabilityKind, draft: AuxiliaryModelDraft, changed: (keyof AuxiliaryModelDraft)[]): DraftCommit<AuxiliaryModelDraft, UpdateAuxiliaryModelConfigInput> {
  const patch: UpdateAuxiliaryModelConfigInput = {};
  const errors: DraftErrors<AuxiliaryModelDraft> = {};
  const accepted: (keyof AuxiliaryModelDraft)[] = [];
  const labels = { name: '配置名称', baseUrl: 'API 地址', model: '模型名称' };
  const customBaseIssue = kind === 'image_generation' && draft.imageProvider === 'customOpenAIImages'
    ? getCustomImageBaseURLError(draft.baseUrl) : null;
  for (const key of changed) {
    if (key === 'imageProvider') {
      if (kind !== 'image_generation') continue;
      if (!IMAGE_GENERATION_PROVIDERS.some(provider => provider.id === draft.imageProvider)) { errors.imageProvider = '请选择生图供应商'; continue; }
      patch.metadataJson = JSON.stringify({ provider: draft.imageProvider });
    } else if (key === 'name' || key === 'baseUrl' || key === 'model') {
      if (!draft[key].trim()) { errors[key] = `${labels[key]}不能为空；这次修改尚未保存。`; continue; }
      if (key === 'baseUrl' && customBaseIssue) { errors.baseUrl = customBaseIssue; continue; }
      patch[key] = draft[key].trim();
    } else if (key === 'serviceConfigId') {
      if (customBaseIssue) continue;
      patch.serviceConfigId = draft.serviceConfigId || null;
    } else if (key === 'apiKey') {
      if (customBaseIssue) { errors.apiKey = '请先填写有效的 API 地址；Key 尚未保存。'; continue; }
      patch.apiKey = draft.apiKey.trim() || null;
    } else if (key === 'tempInput' || key === 'topPInput') {
      if (kind === 'embedding') continue;
      if (kind === 'image_generation') { patch[key === 'tempInput' ? 'temperature' : 'topP'] = null; accepted.push(key); continue; }
      const parsed = readDraftNumber(draft[key], key === 'tempInput' ? 'Temperature' : 'Top P', 0, key === 'tempInput' ? 2 : 1, true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch[key === 'tempInput' ? 'temperature' : 'topP'] = parsed.value;
    } else if (key === 'maxTokens') {
      if (kind === 'embedding') continue;
      if (kind === 'image_generation') { patch.maxTokens = null; accepted.push(key); continue; }
      const parsed = readDraftInteger(draft.maxTokens, 'Max Tokens', true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch.maxTokens = parsed.value;
    }
    accepted.push(key);
  }
  return { patch, accepted, errors };
}
