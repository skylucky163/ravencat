/** 用户备注只表达当前身份事实；操作历史由 Chat 时间线保存。 */
import { aiAssistantRepository } from './infrastructure/SQLiteAssistantRepository';

export function getAssistantDisplayName(assistant: { name: string; nickname?: string | null }): string {
  return assistant.nickname ?? assistant.name;
}

export function formatAssistantNicknameContext(context: { nickname: string | null }): { content: string } {
  return { content: context.nickname === null ? '' : [
    '【昵称】',
    `用户当前给你的昵称备注为${JSON.stringify(context.nickname)}。`,
  ].join('\n') };
}

export async function getAssistantNicknamePromptContext(assistantId: string): Promise<{ content: string }> {
  const context = await aiAssistantRepository.getNicknameContext(assistantId);
  if (!context) throw new Error(`无法读取不存在的AI的昵称备注：${assistantId}`);
  return formatAssistantNicknameContext(context);
}
