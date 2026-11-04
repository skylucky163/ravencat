/** 上下文条数独立校验和提交，不携带页面显示偏好。 */
import type { AIProfile, AIAssistantSettingsUpdate } from '@features/assistants';
import type { DraftCommit } from '@shared/ui/AutoSaveDraftEditor';
import { readDraftInteger } from '@shared/ui/draftValidation';

export interface ContextLimitsDraft {
  privatePrimary: string;
  privateSecondary: string;
  groupPrimary: string;
  groupSecondary: string;
}

export function getContextSettingsDraft(ai: AIProfile): ContextLimitsDraft {
  return {
    privatePrimary: String(ai.privateContextPrimaryLimit), privateSecondary: String(ai.privateContextSecondaryLimit),
    groupPrimary: String(ai.groupContextPrimaryLimit), groupSecondary: String(ai.groupContextSecondaryLimit),
  };
}

export function parseContextSettingsDraft(
  draft: ContextLimitsDraft,
  changed: (keyof ContextLimitsDraft)[],
): DraftCommit<ContextLimitsDraft, AIAssistantSettingsUpdate> {
  const result: DraftCommit<ContextLimitsDraft, AIAssistantSettingsUpdate> = { patch: {}, accepted: [], errors: {} };
  const fields = {
    privatePrimary: 'privateContextPrimaryLimit', privateSecondary: 'privateContextSecondaryLimit',
    groupPrimary: 'groupContextPrimaryLimit', groupSecondary: 'groupContextSecondaryLimit',
  } as const;
  for (const field of changed) {
    const guest = field === 'privateSecondary' || field === 'groupSecondary';
    const parsed = readDraftInteger(draft[field], guest ? '背景条数（0 为不带入）' : '当前对话条数', false, guest ? 0 : 1);
    if (parsed.error) { result.errors[field] = parsed.error; continue; }
    result.patch[fields[field]] = parsed.value;
    result.accepted.push(field);
  }
  return result;
}
