/** 管理员页面拥有输入校验；合法字段按实际修改形成增量命令。 */
import type { DraftCommit, DraftErrors } from '@shared/ui/AutoSaveDraftEditor';
import { readDraftInteger, readDraftNumber } from '@shared/ui/draftValidation';
import type { GroupChatAdminConfig, UpdateGroupChatAdminConfigInput } from '../../group/domain/GroupChat';

export interface GroupAdminSettingsDraft {
  serviceConfigId: string;
  apiBaseUrl: string;
  apiKey: string;
  selectedModel: string;
  tempInput: string;
  topPInput: string;
  maxTokens: string;
  contextMessageCount: string;
  systemPrompt: string;
}

export function getGroupAdminSettingsDraft(config?: GroupChatAdminConfig | null): GroupAdminSettingsDraft {
  return {
    serviceConfigId: config?.serviceConfigId ?? '',
    apiBaseUrl: config?.apiBaseUrl ?? '', apiKey: config?.apiKey ?? '', selectedModel: config?.model ?? '',
    tempInput: config?.temperature == null ? '' : String(config.temperature),
    topPInput: config?.topP == null ? '' : String(config.topP),
    maxTokens: config?.maxTokens === null ? '无限制' : String(config?.maxTokens ?? 2000),
    contextMessageCount: String(config?.contextMessageCount ?? 20), systemPrompt: config?.systemPrompt ?? '',
  };
}

export function parseGroupAdminSettingsDraft(draft: GroupAdminSettingsDraft, changed: (keyof GroupAdminSettingsDraft)[]): DraftCommit<GroupAdminSettingsDraft, UpdateGroupChatAdminConfigInput> {
  const patch: UpdateGroupChatAdminConfigInput = {};
  const errors: DraftErrors<GroupAdminSettingsDraft> = {};
  const accepted: (keyof GroupAdminSettingsDraft)[] = [];
  for (const key of changed) {
    if (key === 'tempInput' || key === 'topPInput') {
      const result = readDraftNumber(draft[key], key === 'tempInput' ? 'Temperature' : 'Top P', 0, key === 'tempInput' ? 2 : 1, true);
      if (result.error) { errors[key] = result.error; continue; }
      if (key === 'tempInput') patch.temperature = result.value;
      else patch.topP = result.value;
    } else if (key === 'maxTokens') {
      const result = draft.maxTokens === '无限制' ? { value: null, error: null } : readDraftInteger(draft.maxTokens, 'Max Tokens');
      if (result.error) { errors[key] = result.error; continue; }
      patch.maxTokens = result.value;
    } else if (key === 'contextMessageCount') {
      const value = Number(draft[key]);
      if (!draft[key].trim() || !Number.isInteger(value) || value < 0 || value > 100) {
        errors[key] = '管理员上下文消息数量需要填写 0～100 之间的整数；这次修改尚未保存。';
        continue;
      }
      patch.contextMessageCount = value;
    } else if (key === 'selectedModel') {
      if (!draft[key].trim()) { errors[key] = '请选择管理员模型；这次修改尚未保存。'; continue; }
      patch.model = draft[key].trim();
    } else {
      patch[key] = draft[key].trim() || null;
    }
    accepted.push(key);
  }
  return { patch, accepted, errors };
}
