/** Host 将可信 AI 身份和运行资格交给 Chat；模型只提供群与目标的业务参数。 */
import { changeGroupMembers, renameGroupChat, searchGroupNames, GroupMembershipError } from '@features/chat';
import { listAIAssistantSummaries } from '@features/assistants';
import type { AgentToolExecutionContext, AgentToolExecutionResult, ToolDefinition } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { assertImageToolRunCurrent } from './assertImageToolRunCurrent';

type Input = { group_id?: string; agent_id?: string; name?: string; keyword?: string };
const groupProperty = { group_id: { type: 'string', minLength: 1, maxLength: 120,
  description: '当前群聊可省略；其他场景须提供仍参加的群的 group_id 或 conversationId。' } };
const memberProperty = { agent_id: { type: 'string', minLength: 1, maxLength: 120, description: '目标 AI 的稳定 agentId，来自身份目录。' } };
const targetGroupProperty = { group_id: { type: 'string', minLength: 1, maxLength: 120,
  description: '指定现有群聊的 groupId，可从 search_groups 的结果取得。' } };
function tool(name: string, description: string, parameters: ToolDefinition['parameters'],
  action: 'search' | 'join' | 'add' | 'remove' | 'mute' | 'unmute' | 'leave' | 'rename') {
  return { name, definition: { name, description, parameters },
    async execute(input: Input, context: AgentToolExecutionContext): Promise<AgentToolExecutionResult<unknown>> {
      throwIfAbortSignalAborted(context.abortSignal);
      try {
        if (action === 'search') {
          const data = { groups: await searchGroupNames(input.keyword!) };
          return { status: 'success', data, modelContent: JSON.stringify(data) };
        }
        const groupId = input.group_id ?? (context.task.type === 'group_chat_reply' ? context.task.sessionId : undefined);
        if (!groupId) return { status: 'error', code: 'GROUP_REQUIRED', modelContent: '请提供群聊 ID。', retryable: false };
        const actor = { kind: 'assistant' as const, assistantId: context.task.assistantId };
        const guard = (tx: Parameters<typeof assertImageToolRunCurrent>[0]) => assertImageToolRunCurrent(tx, context);
        // 只有群内调用才归入该群回复回合；其他会话操作该群时仍是独立事件。
        const sourceRunId = context.task.sessionId === groupId ? context.runId : undefined;
        let data;
        if (action === 'rename') data = await renameGroupChat(groupId, input.name!, actor, guard, sourceRunId);
        else {
          let targetId = context.task.assistantId;
          if (action !== 'leave' && action !== 'join') {
            const target = (await listAIAssistantSummaries()).find(ai => ai.agentId === input.agent_id);
            if (!target) throw new GroupMembershipError('未找到目标 AI，请使用身份目录中的稳定 agentId');
            targetId = target.id;
          }
          data = await changeGroupMembers(groupId, action, [targetId], actor, guard, sourceRunId);
        }
        return { status: 'success', data, modelContent: JSON.stringify(data) };
      } catch (error) {
        if (error instanceof GroupMembershipError) return { status: 'error', code: 'GROUP_OPERATION_DENIED', modelContent: error.message, retryable: false };
        throw error;
      }
    },
  };
}
const memberParameters = { type: 'object', properties: { ...groupProperty, ...memberProperty }, required: ['agent_id'], additionalProperties: false };
const manageRule = '只有仍参加该群的当前主理 AI 可以操作。无需逐次向用户确认。';
export const groupManagementTools = [
  { tool: tool('search_groups', '按群名关键词进行字面包含匹配，返回匹配群的真实名称 name 与 groupId，包括自己尚未加入的群。英文匹配不区分大小写。',
    { type: 'object', properties: { keyword: { type: 'string', minLength: 1, maxLength: 120, description: '群聊名称中的关键词，按字面匹配，不是通配符或正则' } }, required: ['keyword'], additionalProperties: false }, 'search'), hostOnly: false, readOnly: true },
  { tool: tool('join_group', '申请加入指定群聊，执行后直接入群，无需审批。',
    { type: 'object', properties: targetGroupProperty, required: ['group_id'], additionalProperties: false }, 'join'), hostOnly: false, readOnly: false },
  { tool: tool('add_group_member', '邀请指定 Agent ID 对应的现有 AI 加入指定群聊。',
    { type: 'object', properties: { ...targetGroupProperty, ...memberProperty }, required: ['group_id', 'agent_id'], additionalProperties: false }, 'add'), hostOnly: false, readOnly: false },
  { tool: tool('remove_group_member', `将 AI 移出群聊。${manageRule}`, memberParameters, 'remove'), hostOnly: true, readOnly: false },
  { tool: tool('mute_group_member', `禁言 AI。${manageRule}`, memberParameters, 'mute'), hostOnly: true, readOnly: false },
  { tool: tool('unmute_group_member', `解除 AI 的群内禁言。${manageRule}`, memberParameters, 'unmute'), hostOnly: true, readOnly: false },
  { tool: tool('leave_group', '退出群聊，保留退出前历史。需要告别时先发言再退出。',
    { type: 'object', properties: groupProperty, additionalProperties: false }, 'leave'), hostOnly: false, readOnly: false },
  { tool: tool('rename_group', '修改自己仍参加的群聊的名称；名称为 1～30 个字符。',
    { type: 'object', properties: { ...groupProperty, name: { type: 'string', minLength: 1, maxLength: 30 } }, required: ['name'], additionalProperties: false }, 'rename'), hostOnly: false, readOnly: false },
] as const;
