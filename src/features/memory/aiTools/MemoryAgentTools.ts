/** 记忆工具接受正文与可选摘要，空间与幂等键来自运行宿主。 */
import type { AgentToolExecutionContext, AgentToolExecutionResult } from '@shared/aiTools';
import { throwIfAbortSignalAborted } from '@shared/runtime/abortSignal';
import { MemoryInputError, MemoryNotFoundError, type MemoryRecallInput } from '../domain/Memory';
import { rememberMemory, editMemory, forgetMemory } from '../application/MemoryCommands';
import { recallMemoryForRun } from '../application/RecallMemory';
import { getMemoryRuntimeDependencies } from '../application/MemoryRuntimeDependencies';

// 字数上限、content 整体替换等已由参数 schema 表达，工具 description 不再复述。
// 跨 AI 读写由 pool 隔离（每个 AI 一个 pool，SQL 按 pool_id + id 定位），
// 所以也不写「不能改/删其他 AI 的记忆」——那是代码保证的事，写了只是占位。
async function result<T>(context: AgentToolExecutionContext, operation: () => Promise<T>): Promise<AgentToolExecutionResult<T>> {
  throwIfAbortSignalAborted(context.abortSignal);
  try {
    const data = await operation();
    return { status: 'success', data, modelContent: JSON.stringify(data) };
  } catch (error) {
    if (error instanceof MemoryInputError || error instanceof MemoryNotFoundError) {
      return { status: 'error', code: 'MEMORY_INPUT_ERROR', retryable: false, modelContent: error.message };
    }
    throw error;
  }
}
export const RememberMemoryTool = {
  name: 'remember_memory',
  definition: {
    name: 'remember_memory', description: '明确保存一条独立长期记忆，无需向量模型；只保存你提供的正文与摘要，不自动摘录原话。',
    parameters: { type: 'object', properties: { content: { type: 'string', description: '完整记忆正文，最多 500 个 Unicode 字符' }, summary: { type: 'string', description: '可选的检索摘要，最多 50 个 Unicode 字符', maxLength: 50 } }, required: ['content'], additionalProperties: false },
  },
  execute: (input: { content: string; summary?: string }, context: AgentToolExecutionContext) => result(context, () =>
    rememberMemory(context.task.assistantId, input.content, JSON.stringify([context.runId, context.toolCallId]), input.summary ?? null)),
};
export const ConvertExitedGroupHistoryTool = {
  name: 'convert_exited_group_history_to_memory',
  definition: {
    name: 'convert_exited_group_history_to_memory',
    description: '将自己已退出群聊的冻结摘要与聊天记录交给模型提炼为一条长期记忆，自动以【群聊·退出时群名】为标题，返回 memoryId（id）供 update_memory 继续整理。group_id 来自自己的退出历史背景；仍在群内不能使用。重复转换同一份退出记录返回已有记忆，不覆盖后续编辑；不改变用户的历史注入开关。',
    parameters: { type: 'object', properties: { group_id: { type: 'string', minLength: 1, maxLength: 120,
      description: '自己已退出群聊的 group_id / conversationId' } }, required: ['group_id'], additionalProperties: false },
  },
  execute: (input: { group_id: string }, context: AgentToolExecutionContext) => result(context, () =>
    getMemoryRuntimeDependencies().convertExitedGroupHistory(input.group_id, context)),
};
export const RecallMemoryTool = {
  name: 'recall_memory',
  definition: {
    name: 'recall_memory', description: '检索当前 AI 的独立记忆，返回正文与摘要。query 是语义查询原句，keywords 匹配摘要或正文（不区分大小写／全半角），至少提供一种；关键词优先，向量补充。向量化关闭或不可用时使用 keywords 检索。翻页沿用相同 query/keywords 并传回 nextOffset，offset 0 为首次或刷新。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, offset: { type: 'integer', minimum: 0 } }, required: [], additionalProperties: false },
  },
  execute: (input: MemoryRecallInput, context: AgentToolExecutionContext) => result(context, () =>
    recallMemoryForRun(context.task.assistantId, context.runId, input, context.abortSignal)),
};
export const UpdateMemoryTool = {
  name: 'update_memory',
  definition: {
    name: 'update_memory', description: '按 memoryId 更新当前 AI 已有的一条记忆；先用 recall_memory 确认目标。content 会整体替换原正文，需保留仍有效的信息。',
    parameters: { type: 'object', properties: {
      memoryId: { type: 'string', description: '已保存或检索结果中的记忆条目 id' },
      content: { type: 'string', description: '更新后的完整记忆正文，最多 500 个 Unicode 字符，不是要追加的片段' },
      summary: { type: 'string', description: '可选的检索摘要，最多 50 字；省略保留原摘要，空字符串清除摘要', maxLength: 50 },
    }, required: ['memoryId', 'content'], additionalProperties: false },
  },
  execute: (input: { memoryId: string; content: string; summary?: string }, context: AgentToolExecutionContext) => result(context, () =>
    editMemory(context.task.assistantId, input.memoryId, input.content, input.summary)),
};
export const ForgetMemoryTool = {
  name: 'forget_memory',
  definition: {
    name: 'forget_memory', description: '按 memoryId 删除当前 AI 的一条记忆；先确认目标。',
    parameters: { type: 'object', properties: { memoryId: { type: 'string' } }, required: ['memoryId'], additionalProperties: false },
  },
  execute: (input: { memoryId: string }, context: AgentToolExecutionContext) => result(context, async () =>
    ({ deleted: await forgetMemory(context.task.assistantId, input.memoryId) })),
};
