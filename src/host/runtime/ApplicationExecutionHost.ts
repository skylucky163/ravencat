/** 唯一的应用业务分发入口；原生只保留一个常驻 RN 身份，每个请求不创建原生任务。 */
import {
  connectApplicationExecutionHost, subscribeApplicationExecutions, takeApplicationExecutions,
  completeApplicationExecution, type ApplicationExecutionRequest,
} from '@platform/device';
import { runCompanionWake } from '@features/companion';
import { executeFloatingMessage } from '@features/companion/composition';
import { executeConversationTurns } from './ExecuteConversationTurns';
import { executeHostRelationshipReply } from './ExecuteHostRelationshipReply';
import { executeCall } from './ExecuteCall';
import { executeCallNotificationAction } from '../notifications/CallNotificationAction';
import { executeTogetherListeningNotificationAction } from '../notifications/TogetherListeningNotificationAction';

export interface ApplicationExecutionContext {
  requestId: string;
  signal: AbortSignal;
  executionDeadlineAt: number;
}

export async function executeApplicationRequest(request: ApplicationExecutionRequest): Promise<void> {
  const controller = new AbortController();
  const executionDeadlineAt = request.remainingMs === null ? Infinity : performance.now() + request.remainingMs;
  const timeout = request.remainingMs === null ? null : setTimeout(() => controller.abort('execution_deadline'), request.remainingMs);
  if (request.remainingMs === 0) controller.abort('execution_deadline');
  const execution = { requestId: request.id, signal: controller.signal, executionDeadlineAt };
  const data = request.data;
  try {
    switch (request.kind) {
      case 'conversation': await executeConversationTurns(data, execution); break;
      case 'relationship': await executeHostRelationshipReply(data, execution); break;
      case 'companion': await runCompanionWake(data, execution.signal); break;
      case 'floating': await executeFloatingMessage(data, execution); break;
      case 'call': await executeCall(data); break;
      case 'call_action': await executeCallNotificationAction(data); break;
      case 'together_action': await executeTogetherListeningNotificationAction(data); break;
      default: throw new Error(`未知应用执行请求：${request.kind}`);
    }
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    await completeApplicationExecution(request.id);
  }
}

let configured = false;
export function configureApplicationExecutionHost(): void {
  if (configured) return;
  configured = true;
  const drain = () => {
    void takeApplicationExecutions().then(requests => {
      for (const request of requests) {
        void executeApplicationRequest(request).catch(error => {
          console.error('[ApplicationExecutionHost] 请求执行失败', { id: request.id, kind: request.kind, error });
        });
      }
    }).catch(error => console.error('[ApplicationExecutionHost] 无法取得原生请求', error));
  };
  // 先监听，再握手和读取信箱；不轮询，不维护第二份 JS 待执行队列。
  subscribeApplicationExecutions(drain);
  void connectApplicationExecutionHost().then(drain).catch(error => {
    console.error('[ApplicationExecutionHost] 应用执行宿主连接失败', error);
  });
}
