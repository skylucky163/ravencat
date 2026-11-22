/** 暴露群聊管理员内部任务的提示词元数据。 */

import type { PromptDefinitionDescriptor } from '@shared/prompt';
import {
  DEFAULT_GROUP_ADMIN_PROMPT,
  GROUP_ADMIN_OUTPUT_CONTRACT,
} from './GroupTaskPromptBlocks';

export const GROUP_TASK_PROMPT_DEFINITIONS = [
  {
    id: 'scenario.group_admin_schedule',
    version: 3,
    name: '群聊管理员调度',
    description: '根据群成员、召唤消息与近期上下文选择本轮发言 AI。',
    owner: 'chat',
    category: 'scenario',
    supportedScenarios: ['chat.group_admin_schedule'],
    defaultSlot: 'scenario',
    placement: 'system',
    protection: 'overridable',
    // 全部群共用一份正文，不按 AI 覆盖。
    editScope: 'global',
    contentKind: 'template',
    content: DEFAULT_GROUP_ADMIN_PROMPT,
    defaultContent: DEFAULT_GROUP_ADMIN_PROMPT,
    sourcePath: 'src/features/chat/group/application/GroupTaskPromptBlocks.ts',
  },
  {
    id: 'output.group_admin_speaker_array',
    version: 3,
    name: '群聊发言成员数组契约',
    description: '只返回候选成员本轮短别名组成的 JSON 数组。',
    owner: 'chat',
    category: 'output',
    supportedScenarios: ['chat.group_admin_schedule'],
    defaultSlot: 'output_contract',
    placement: 'system',
    protection: 'locked',
    protectionReason: '调度器只接受候选成员数组，不能执行聊天工具或返回自由文本。',
    contentKind: 'static',
    content: GROUP_ADMIN_OUTPUT_CONTRACT,
    sourcePath: 'src/features/chat/group/application/GroupTaskPromptBlocks.ts',
  },
] satisfies PromptDefinitionDescriptor[];
