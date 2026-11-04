/** 个人主页的资料输入边界；继续提交助手已有字段，不复制人设。 */
import type { AIProfile } from '../../domain/AIProfile';
import type { AIAssistantSettingsUpdate } from '../../domain/AssistantRepository';
import type { DraftCommit } from '@shared/ui/AutoSaveDraftEditor';

export interface AssistantProfileDraft {
  name: string;
  nickname: string;
  systemPrompt: string;
}

export function getAssistantProfileDraft(ai: AIProfile): AssistantProfileDraft {
  return { name: ai.name, nickname: ai.nickname ?? '', systemPrompt: ai.systemPrompt ?? '' };
}

export function parseAssistantProfileDraft(
  draft: AssistantProfileDraft,
  changed: (keyof AssistantProfileDraft)[],
): DraftCommit<AssistantProfileDraft, AIAssistantSettingsUpdate> {
  const result: DraftCommit<AssistantProfileDraft, AIAssistantSettingsUpdate> = { patch: {}, accepted: [], errors: {} };
  for (const field of changed) {
    if (field === 'name') {
      const name = draft.name.trim();
      if (!name) { result.errors.name = 'AI 名称不能为空；这次修改尚未保存。'; continue; }
      if (Array.from(name).length > 20 || /[\r\n]/.test(name)) {
        result.errors.name = '名称需为单行，最多20个字符；这次修改尚未保存。'; continue;
      }
      result.patch.name = name;
    } else if (field === 'nickname') {
      const nickname = draft.nickname.trim();
      if (Array.from(nickname).length > 20 || /[\r\n]/.test(nickname)) {
        result.errors.nickname = '昵称需为单行，最多20个字符；这次修改尚未保存。'; continue;
      }
      result.patch.nickname = nickname || null;
    } else {
      result.patch.systemPrompt = draft.systemPrompt;
    }
    result.accepted.push(field);
  }
  return result;
}
