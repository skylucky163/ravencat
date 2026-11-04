/**
 * canonical user_reply 的 Android-backed execution host 触发口：
 * 页面在 T1 commit 后向共享应用宿主提交请求，执行不依赖 React 页面存活。
 */
import { postApplicationExecution } from './BackgroundRuntime';

/** 用户身份操作的即时唤醒，不借用 canonical 用户消息或页面执行。 */
export const startHostRelationshipReplyExecution = (aiId: string, change: 'appointed' | 'revoked', occurredAt: string) =>
  postApplicationExecution('relationship', { aiId, change, occurredAt }, 540_000);

export interface ConversationTurnExecutionStartOptions {
  correlationId?: string | null;
  deliveryTiming?: 'paced' | 'immediate' | null;
}

/**
 * 提交会话回合请求；多个会话在同一请求内串行等待终态，不创建原生任务。
 * 返回原生信箱是否接受请求；拒绝时待回复事实仍留在持久化游标/高水位中，
 * 由后续 execution host 触发或启动恢复按 orphan 语义接管，不做页面内兜底执行。
 */
export async function startConversationTurnExecutionHost(
  sessionIds: string[],
  options: ConversationTurnExecutionStartOptions = {},
): Promise<boolean> {
  if (sessionIds.length === 0) {
    return true;
  }
  try {
    return await postApplicationExecution('conversation', { sessionIds, ...options }, 540_000);
  } catch (error) {
    console.warn('[ConversationTurnExecutionHost] 启动 execution host 失败：', {
      sessionIds,
      correlationId: options.correlationId ?? null,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
