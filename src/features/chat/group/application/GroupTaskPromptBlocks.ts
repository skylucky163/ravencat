/** 构造群聊管理员内部模型任务使用的受保护 Prompt Blocks。 */

import {
  type PromptPackBlock,
  type PromptScenarioId,
} from '@shared/prompt';

export const DEFAULT_GROUP_ADMIN_PROMPT = [
  '你是一个不可见的群聊发言顺序调度管理员。',
  '请根据本轮用户消息和近期上下文编排适合发言的成员，优先选择正在参与讨论或者被明确期望发言的成员。',
  '禁止生成聊天正文，禁止扮演任何群成员。',
].join('\n');

export const GROUP_ADMIN_OUTPUT_CONTRACT = [
  '只返回“本次可追加发言候选”中的本轮短别名，格式为 JSON 字符串数组，例如 ["member_1","member_3"]。',
  '短别名只对当前输入有效，不要返回成员名称，也不要猜测或输出任何内部 ID。',
  '不要解释，不要输出 Markdown，不要输出对象。如果无法判断可返回空数组，程序会召唤全部候选成员。',
].join('\n');

export function buildGroupAdminPromptBlocks(systemPrompt: string): PromptPackBlock[] {
  return [
    block(
      'chat.group_admin_schedule',
      'scenario.group_admin_schedule',
      '群聊管理员调度',
      // 正文由调用方解析（提示词中心全局一份），这里不再回落内置默认。
      systemPrompt,
      'scenario',
      'overridable',
    ),
    block(
      'chat.group_admin_schedule',
      'output.group_admin_speaker_array',
      '群聊发言成员数组契约',
      GROUP_ADMIN_OUTPUT_CONTRACT,
      'output_contract',
      'locked',
    ),
  ];
}

function block(
  scenario: PromptScenarioId,
  definitionId: string,
  title: string,
  content: string,
  slot: 'foundation' | 'scenario' | 'output_contract',
  protection: 'overridable' | 'locked',
): PromptPackBlock {
  return {
    key: 'persona',
    instanceId: `chatTask:${definitionId}`,
    definitionId,
    slot,
    protection,
    title,
    content,
    required: true,
    status: 'ready',
    source: 'GroupTaskPromptBlocks',
    truncatable: protection !== 'locked',
    scenario,
    placement: 'system',
  };
}
