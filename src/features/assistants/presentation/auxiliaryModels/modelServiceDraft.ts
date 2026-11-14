/** 表单边界负责输入合法性；名称和凭据独立提交，默认编号不参与绑定身份。 */
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import type { ModelServiceKeyInput } from '../../domain/ModelService';

export interface ServiceGroupDraft { name: string; baseUrl: string }
export interface ServiceKeyDraft { name: string; apiKey: string; secretId: string; appId: string }
export function parseServiceGroupDraft(draft: ServiceGroupDraft, changed: (keyof ServiceGroupDraft)[]): DraftCommit<ServiceGroupDraft, Partial<ServiceGroupDraft>> {
  const patch: Partial<ServiceGroupDraft> = {}, errors: DraftErrors<ServiceGroupDraft> = {}, accepted: (keyof ServiceGroupDraft)[] = [];
  for (const key of changed) {
    const value = draft[key].trim();
    if (key === 'name' && !value) { errors.name = '请填写配置名称'; continue; }
    if (key === 'baseUrl') {
      try {
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(new URL(value).protocol)) { errors.baseUrl = '请填写 HTTP 或 WebSocket 服务地址'; continue; }
      } catch { errors.baseUrl = '请填写完整服务地址'; continue; }
    }
    patch[key] = value; accepted.push(key);
  }
  return { patch, errors, accepted };
}
export function parseServiceKeyDraft(draft: ServiceKeyDraft, changed: (keyof ServiceKeyDraft)[], authType: 'apiKey' | 'tencentCloud', creating = false): DraftCommit<ServiceKeyDraft, Partial<ModelServiceKeyInput>> {
  const fields = creating ? Object.keys(draft) as (keyof ServiceKeyDraft)[] : changed;
  const patch: Partial<ModelServiceKeyInput> = {}, errors: DraftErrors<ServiceKeyDraft> = {}, accepted: (keyof ServiceKeyDraft)[] = [];
  if (fields.includes('name')) { patch.name = draft.name.trim(); accepted.push('name'); }
  if (fields.includes('apiKey')) {
    if (!draft.apiKey.trim()) errors.apiKey = '请填写 API Key';
    else { patch.apiKey = draft.apiKey.trim(); accepted.push('apiKey'); }
  }
  const credentials = fields.filter(key => key === 'secretId' || key === 'appId');
  if (credentials.length) {
    if (authType === 'tencentCloud' && !draft.secretId.trim()) errors.secretId = '请填写 SecretId';
    else {
      patch.credentialsJson = JSON.stringify(authType === 'apiKey' ? {} : { secretId: draft.secretId.trim(), ...(draft.appId.trim() ? { appId: draft.appId.trim() } : {}) });
      accepted.push(...credentials);
    }
  }
  return { patch, errors, accepted: creating && Object.keys(errors).length ? [] : accepted };
}
