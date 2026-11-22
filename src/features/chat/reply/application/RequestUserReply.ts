/** 召唤只持久化回复授权并交给既有 Android 宿主，不创建占位消息。 */
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { emitChatTurnExecutionChanged } from '../../messages/events/ChatEvents';

export async function requestUserReply(sessionId: string): Promise<boolean> {
  const runtime = getChatMessageRuntimeDependencies();
  if (!await runtime.turns.requestUserReply(sessionId)) return false;
  emitChatTurnExecutionChanged(sessionId);
  if (!await runtime.userReplyRequest.onRequested(sessionId)) throw new Error('召唤请求暂未被执行宿主接收，请稍后重试。');
  return true;
}
