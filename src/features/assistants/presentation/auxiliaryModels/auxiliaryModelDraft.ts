/** 辅助模型输入转换；各字段独立校验和更新。 */
import type { AuxiliaryModelConfig, CapabilityKind, UpdateAuxiliaryModelConfigInput } from '../../domain/AuxiliaryModel';
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { readDraftNumber, readDraftInteger } from '@shared/ui/draftValidation';
export interface AuxiliaryModelDraft {
  serviceConfigId: string;
  name: string; baseUrl: string; apiKey: string; model: string;
  tempInput: string; topPInput: string; maxTokens: string;
}
export function getAuxiliaryModelDraft(data: AuxiliaryModelConfig | null): AuxiliaryModelDraft {
  return {
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
  for (const key of changed) {
    if (key === 'name' || key === 'baseUrl' || key === 'model') {
      if (!draft[key].trim()) { errors[key] = `${labels[key]}不能为空；这次修改尚未保存。`; continue; }
      patch[key] = draft[key].trim();
    } else if (key === 'serviceConfigId') {
      patch.serviceConfigId = draft.serviceConfigId || null;
    } else if (key === 'apiKey') {
      patch.apiKey = draft.apiKey.trim() || null;

    } else if (key === 'tempInput' || key === 'topPInput') {
      if (kind === 'embedding') continue;
      const parsed = readDraftNumber(draft[key], key === 'tempInput' ? 'Temperature' : 'Top P', 0, key === 'tempInput' ? 2 : 1, true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch[key === 'tempInput' ? 'temperature' : 'topP'] = parsed.value;
    } else if (key === 'maxTokens') {
      if (kind === 'embedding') continue;
      const parsed = draft.maxTokens === '无限制'
        ? { value: null, error: null } : readDraftInteger(draft.maxTokens, 'Max Tokens', true);
      if (parsed.error) { errors[key] = parsed.error; continue; }
      patch.maxTokens = parsed.value;
    }
    accepted.push(key);
  }
  return { patch, accepted, errors };
}
