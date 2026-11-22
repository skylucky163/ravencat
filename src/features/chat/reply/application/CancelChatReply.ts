/** 用户终止先撤销持久提交资格，再取消在途执行；不等待模型或工具配合退出。 */
import { getChatMessageRuntimeDependencies } from '../../messages/application/ChatMessageRuntime';
import { emitChatRegenerationChanged, emitChatTurnExecutionChanged } from '../../messages/events/ChatEvents';

export async function cancelChatReply(sessionId: string): Promise<void> {
  const { turns, turnPresentation, turnCancellation } = getChatMessageRuntimeDependencies();
  const release = await turnPresentation.freeze(sessionId);
  let committed = false;
  try {
    await turns.cancelCurrentTurn(sessionId);
    committed = true;
    emitChatTurnExecutionChanged(sessionId);
    emitChatRegenerationChanged(sessionId);
    try {
      await turnCancellation.onCommitted(sessionId);
    } finally {
      await turnPresentation.interrupt(sessionId);
    }
  } finally {
    await release(committed);
  }
}
