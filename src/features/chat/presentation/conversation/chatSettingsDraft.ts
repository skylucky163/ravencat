/** 对话页面偏好独立提交；上下文草稿由上下文页持有。 */
import type { AIProfile, AIAssistantSettingsUpdate } from '@features/assistants';
import type { DraftCommit } from '@shared/ui/AutoSaveDraftEditor';

export interface ChatSettingsDraft {
  allowMultipleBubbles: boolean;
  streamingReply: boolean | null;
  showTokenUsage: boolean;
  showActionSteps: boolean;
}

export function getChatSettingsDraft(ai: AIProfile): ChatSettingsDraft {
  return { allowMultipleBubbles: ai.allowMultipleBubbles, streamingReply: ai.streamingReply,
    showTokenUsage: ai.showTokenUsage, showActionSteps: ai.showActionSteps };
}

export function parseChatSettingsDraft(
  draft: ChatSettingsDraft,
  changed: (keyof ChatSettingsDraft)[],
): DraftCommit<ChatSettingsDraft, AIAssistantSettingsUpdate> {
  const result: DraftCommit<ChatSettingsDraft, AIAssistantSettingsUpdate> = { patch: {}, accepted: [], errors: {} };
  for (const field of changed) {
    if (field === 'streamingReply') result.patch.streamingReply = draft.streamingReply;
    else result.patch[field] = draft[field];
    result.accepted.push(field);
  }
  return result;
}
