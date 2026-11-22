/** 读取持久执行事实，不以计时或 typing 动画猜测运行状态。 */
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { getChatTurnExecutionStatus } from '../../../reply/application/ChatTurnPresentationRuntime';
import type { ChatTurnExecutionStatus } from '../../../reply/domain/ChatTurnPresentation';
import { setChatEventBus } from '../../../messages/events/ChatEvents';

const labels: Record<ChatTurnExecutionStatus['phase'], string | null> = {
  waiting_host: null, host_started: null, preparing: '正在准备请求',
  waiting_model: '等待模型响应', receiving_model: '正在接收模型输出', executing_tool: '正在执行工具',
  processing_result: '正在整理工具结果', committing: null, delivering: null, closing: null,
  request_failed: null, failed: null, interrupted: null,
};

export function formatChatTurnExecutionStatus(status: ChatTurnExecutionStatus | null): string | null {
  // 用户发送已有气泡反馈，宿主交接只留诊断；标题承载 AI 处理进度，终态恢复名字。
  return status ? labels[status.phase] : null;
}

export function useChatTurnExecutionStatus(sessionId: string | null) {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; status: ChatTurnExecutionStatus | null } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    let requestedRevision = 0;
    let reading = false;
    const reload = () => {
      requestedRevision++;
      if (reading) return;
      reading = true;
      // 同一会话至多一个读取在途；期间的新事实合并为下一次读取，不让旧结果回写。
      void (async () => {
        try {
          while (active) {
            const revision = requestedRevision;
            try {
              const status = await getChatTurnExecutionStatus(sessionId);
              if (active && revision === requestedRevision) setSnapshot({ sessionId, status });
            } catch (error) {
              console.error('[ChatTurnExecutionStatus] 执行状态读取失败', error);
              if (active && revision === requestedRevision) setSnapshot({ sessionId, status: null });
            }
            if (revision === requestedRevision) break;
          }
        } finally { reading = false; }
      })();
    };
    reload();
    const stop = setChatEventBus({ emit: (name, payload) => {
      if (payload.sessionId === sessionId && name === 'turnExecutionChanged') reload();
    } });
    const appState = AppState.addEventListener('change', state => { if (state === 'active') reload(); });
    return () => { active = false; stop(); appState.remove(); };
  }, [sessionId]);
  const status = snapshot?.sessionId === sessionId ? snapshot.status : null;
  return {
    statusText: formatChatTurnExecutionStatus(status),
    // 终止针对生成与工具执行；生成结束后的定稿、交付和清理继续由原 owner 完成。
    canStop: status !== null && ['waiting_host', 'host_started', 'preparing', 'waiting_model',
      'receiving_model', 'executing_tool', 'processing_result'].includes(status.phase),
  };
}
