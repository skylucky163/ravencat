/**
 * @fileoverview Chat 回复 run 的协作式取消（Phase 5A）。
 *
 * 取代旧的 ChatReplyRunState 注册表：取消正确性由持久化 fence 保证，
 * AbortSignal 只是节省模型/工具资源的协作式提示，从不作为正确性依据。
 * 旁路调用方不传 signal 时，全部检查点为空操作，行为与现状一致。
 */

import type { AIReplyRuntimeContext } from './ChatReplyTypes';

export type ChatReplyRunCancelReason = 'superseded' | 'aborted';

export class ChatReplyRunCancelledError extends Error {
  readonly reason: ChatReplyRunCancelReason;

  constructor(reason: ChatReplyRunCancelReason = 'aborted') {
    super(`Chat reply run cancelled: ${reason}`);
    this.name = 'ChatReplyRunCancelledError';
    this.reason = reason;
  }
}

/** 协作式检查点：signal 已 abort 时抛取消错误，中断当前 run 的后续工作。 */
export function assertChatReplyNotAborted(
  runtimeContext: AIReplyRuntimeContext
): void {
  if (runtimeContext.executionDeadlineAt !== undefined && performance.now() >= runtimeContext.executionDeadlineAt) {
    throw new Error('execution_host_timeout');
  }
  if (runtimeContext.abortSignal?.aborted) {
    throw new ChatReplyRunCancelledError('aborted');
  }
}

/** 非抛错版本：供投递节奏等“是否继续”判定使用。 */
export function isChatReplyActive(
  runtimeContext: AIReplyRuntimeContext
): boolean {
  return !runtimeContext.abortSignal?.aborted;
}

/**
 * 错误回复落库门控：signal 已 abort 或 run 已失去提交资格（提交策略已 settled）
 * 时跳过错误气泡落库与失败回调，让旧 run 安静结束。
 */
export function shouldSuppressReplyErrorPersistence(
  runtimeContext: AIReplyRuntimeContext,
  persistence: { isCommitEligible?: () => boolean }
): boolean {
  return Boolean(runtimeContext.abortSignal?.aborted)
    || persistence.isCommitEligible?.() === false;
}

/**
 * 异步版错误落库门控：先走同步 signal/settled 检查，再 await 提交策略暴露的
 * 持久 fence 探针。群聊 plan 被换代后，旧执行上下文的晚到异常不得再写属于
 * 旧 plan 的错误气泡——AbortSignal 只是协作式提示，不能作为正确性依据。
 */
export async function shouldSuppressReplyErrorPersistenceAsync(
  runtimeContext: AIReplyRuntimeContext,
  persistence: {
    isCommitEligible?: () => boolean;
    confirmCommitEligible?: () => Promise<boolean>;
  }
): Promise<boolean> {
  if (shouldSuppressReplyErrorPersistence(runtimeContext, persistence)) {
    return true;
  }
  if (!persistence.confirmCommitEligible) {
    return false;
  }
  return (await persistence.confirmCommitEligible()) === false;
}

export function isChatReplyRunCancellationError(error: unknown): boolean {
  if (error instanceof ChatReplyRunCancelledError) {
    return true;
  }

  // Provider / SQLite 的失败正文也可能含 aborted；文字不是用户取消的证据。
  // 模型网关已把真正的请求失败包装为专用异常，不能在这里按正文推翻其契约。
  return error !== null && typeof error === 'object'
    && 'name' in error && error.name === 'AbortError';
}
