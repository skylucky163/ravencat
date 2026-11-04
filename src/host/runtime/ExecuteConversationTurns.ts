/** 应用宿主承接 canonical user_reply；批量恢复串行等待终态，不创建原生消息任务。 */
import { AppState } from 'react-native';
import { emitChatMessagesUpdated } from '@features/chat/composition';
import { logTurnTimeline } from '@shared/diagnostics/TurnTimelineLog';
import { ensureHostDatabaseReady } from '../composition/ensureHostDatabaseReady';
import { getConversationTurnCoordinator } from './ConversationTurnCoordinator';
import type { ApplicationExecutionContext } from './ApplicationExecutionHost';

interface ConversationTurnRequest {
  sessionIds?: string[];
  correlationId?: string;
  deliveryTiming?: 'paced' | 'immediate';
}

export async function executeConversationTurns(data: ConversationTurnRequest, execution: ApplicationExecutionContext): Promise<void> {
  const sessionIds = (data.sessionIds ?? []).map(id => id?.trim()).filter((id): id is string => Boolean(id));
  if (sessionIds.length === 0) throw new Error('聊天执行请求缺少 sessionIds');
  const correlationId = data.correlationId?.trim() || undefined;
  await ensureHostDatabaseReady();
  const deliveryTiming = AppState.currentState === 'active' ? data.deliveryTiming : 'immediate';
  for (const sessionId of sessionIds) {
    if (execution.signal.aborted || performance.now() >= execution.executionDeadlineAt) break;
    logTurnTimeline('execution_host_started', { hostId: execution.requestId, sessionId, correlationId });
    await getConversationTurnCoordinator().executeTurnFromHost(sessionId, {
      ...execution, correlationId, deliveryTiming, replyCallbacks: { notifyUI: emitChatMessagesUpdated },
    });
  }
}
